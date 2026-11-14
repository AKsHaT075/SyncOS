const crypto = require('crypto');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const AiOrgSettings = require('../../../models/AiOrgSettings');
const Document = require('../../../models/Document');
const DocumentChunk = require('../../../models/DocumentChunk');
const DocumentIngestionJob = require('../../../models/DocumentIngestionJob');
const {
  FAIL_REASONS,
  INGESTION_FORMATS,
  INGESTION_PIPELINE_VERSION: PIPELINE,
  INGESTION_STATUS: S,
  SKIP_REASONS,
} = require('../../../constants/ingestion.constants');

/**
 * Durable ingestion job state machine. MongoDB is the source of truth; every transition is ONE conditional
 * update (no check-then-write), so concurrent workers, sweeps and admins can never double-claim or lose a lease.
 *
 *   queued ──claim──▶ processing ──indexed──▶ indexed
 *      ▲                 │  ├─────skipped───▶ skipped   (permanent, with a reason)
 *      │                 │  └─────failed────▶ failed ──(backoff elapses)──▶ claim again
 *      └── admin retry ──┴────────attempts exhausted───▶ dead
 *
 * A worker holds a lease (lockToken + lockExpiresAt). Heartbeats extend it (bounded by a hard processing cap);
 * if the worker dies the lease lapses and recoverStale() turns the job into failed/dead.
 */

const UNLOCK = { lockedBy: null, lockExpiresAt: null };
const idString = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const maxBytes = () => env.AI_INGEST_MAX_FILE_MB * 1024 * 1024;

function backoffMs(attempts) {
  const base = env.AI_INGEST_BACKOFF_BASE_SECONDS * 1000;
  const raw = Math.min(env.AI_INGEST_BACKOFF_MAX_SECONDS * 1000, base * 2 ** Math.max(0, attempts - 1));
  return Math.round(raw / 2 + Math.random() * (raw / 2)); // jittered so a bad batch does not retry in lockstep
}

async function isAiEnabled(organization) {
  return Boolean(await AiOrgSettings.exists({ organization, enabled: true }));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Decides, from facts Node already has, whether a worker is needed at all. */
function initialState({ extension, size }) {
  const format = INGESTION_FORMATS[String(extension || '').toLowerCase()] || null;
  if (!format) return { status: S.SKIPPED, reason: SKIP_REASONS.UNSUPPORTED_FORMAT, format: null };
  if (size > maxBytes()) return { status: S.SKIPPED, reason: SKIP_REASONS.FILE_TOO_LARGE, format };
  return { status: S.QUEUED, reason: null, format };
}

/**
 * Creates the job for (org, document, version, pipeline) unless it already exists. Safe to call any number of
 * times, from any process: the unique index makes duplicates impossible.
 */
async function enqueue({ organization, document, version, extension, size, checksum, source = 'upload', requireAiEnabled = true }) {
  if (requireAiEnabled && !(await isAiEnabled(organization))) return { created: false, skipped: 'AI_DISABLED' };
  const state = initialState({ extension, size });
  const now = new Date();
  const filter = { organization, document, version, pipelineVersion: PIPELINE };
  try {
    const result = await DocumentIngestionJob.updateOne(
      filter,
      {
        $setOnInsert: {
          ...filter,
          status: state.status,
          reason: state.reason,
          format: state.format,
          extension: String(extension || '').toLowerCase() || null,
          size,
          checksum,
          source,
          attempts: 0,
          maxAttempts: env.AI_INGEST_MAX_ATTEMPTS,
          nextRunAt: now,
          finishedAt: state.status === S.SKIPPED ? now : null,
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount === 0) await reviveDeleted(filter, state, now);
    return { created: result.upsertedCount > 0, status: state.status };
  } catch (error) {
    if (error.code === 11000) return { created: false }; // a concurrent enqueue won the race
    throw error;
  }
}

/**
 * A document that was trashed and is now live again: its "deleted" skip is obsolete, so the same
 * (document, version) row goes back to work. Only that specific skip reason is ever revived.
 */
async function reviveDeleted(filter, state, now = new Date()) {
  const r = await DocumentIngestionJob.updateOne(
    { ...filter, status: S.SKIPPED, reason: SKIP_REASONS.DOCUMENT_DELETED },
    { $set: { status: state.status, reason: state.reason, format: state.format, attempts: 0, nextRunAt: now, finishedAt: state.status === S.SKIPPED ? now : null, stats: null, ...UNLOCK } },
  );
  return r.modifiedCount === 1;
}

/** Enqueues the document's CURRENT version. Used by upload / version / restore hooks. Never throws. */
async function enqueueCurrentVersion(documentId, organization, source) {
  try {
    const doc = await Document.findOne({ _id: documentId, organization, deletedAt: null }).select('organization extension size checksum currentVersion').lean();
    if (!doc) return { created: false };
    return await enqueue({ organization, document: doc._id, version: doc.currentVersion, extension: doc.extension, size: doc.size, checksum: doc.checksum, source });
  } catch (error) {
    console.error('[ai-ingest] enqueue failed:', error.name); // never the message: it could carry document names
    return { created: false, error: true };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Failure / skip transitions (all fenced by the lock token unless told otherwise)

function lockFilter(jobId, lockToken, now = new Date()) {
  return { _id: jobId, status: S.PROCESSING, lockToken, lockExpiresAt: { $gt: now } };
}

/** processing -> failed (retry after backoff) or dead (attempts exhausted). */
async function failJob({ job, reason, fenced = true }) {
  const now = new Date();
  const dead = job.attempts >= job.maxAttempts;
  const filter = fenced ? lockFilter(job._id, job.lockToken, now) : { _id: job._id, status: S.PROCESSING };
  return DocumentIngestionJob.findOneAndUpdate(
    filter,
    {
      $set: {
        status: dead ? S.DEAD : S.FAILED,
        reason,
        nextRunAt: dead ? now : new Date(now.getTime() + backoffMs(job.attempts)),
        finishedAt: dead ? now : null,
        ...UNLOCK,
      },
    },
    { returnDocument: 'after' },
  );
}

/** processing -> skipped, permanently, with a reason. Also removes any chunks (a skipped version has none). */
async function skipJob({ job, reason, fenced = true }) {
  const now = new Date();
  const filter = fenced ? lockFilter(job._id, job.lockToken, now) : { _id: job._id, status: { $in: [S.PROCESSING, S.QUEUED, S.FAILED] } };
  const updated = await DocumentIngestionJob.findOneAndUpdate(
    filter,
    { $set: { status: S.SKIPPED, reason, finishedAt: now, stats: null, ...UNLOCK } },
    { returnDocument: 'after' },
  );
  if (updated) {
    await DocumentChunk.deleteMany({ organization: job.organization, document: job.document, version: job.version, pipelineVersion: job.pipelineVersion });
  }
  return updated;
}

/**
 * Jobs whose worker vanished: processing with an expired lease. Exhausted ones become dead; the rest are
 * failed with backoff. Safe to run from every instance at once (conditional updates).
 */
async function recoverStale(now = new Date()) {
  const base = { status: S.PROCESSING, lockExpiresAt: { $lt: now } };
  const dead = await DocumentIngestionJob.updateMany(
    { ...base, $expr: { $gte: ['$attempts', '$maxAttempts'] } },
    { $set: { status: S.DEAD, reason: FAIL_REASONS.LOCK_EXPIRED, finishedAt: now, ...UNLOCK } },
  );
  const stale = await DocumentIngestionJob.find({ ...base, $expr: { $lt: ['$attempts', '$maxAttempts'] } }).select('_id attempts').lean();
  let retried = 0;
  for (const job of stale) {
    // eslint-disable-next-line no-await-in-loop
    const r = await DocumentIngestionJob.updateOne(
      { _id: job._id, ...base },
      { $set: { status: S.FAILED, reason: FAIL_REASONS.LOCK_EXPIRED, nextRunAt: new Date(now.getTime() + backoffMs(job.attempts)), ...UNLOCK } },
    );
    retried += r.modifiedCount;
  }
  return { dead: dead.modifiedCount, retried };
}

// ---------------------------------------------------------------------------------------------------------------
// Claim / heartbeat

/** Why a document's CURRENT state no longer matches a job, or null if it still does. */
async function staleReason(job) {
  const doc = await Document.findOne({ _id: job.document, organization: job.organization }).select('deletedAt currentVersion checksum').lean();
  if (!doc || doc.deletedAt) return SKIP_REASONS.DOCUMENT_DELETED;
  if (doc.currentVersion !== job.version || doc.checksum !== job.checksum) return SKIP_REASONS.SUPERSEDED;
  return null;
}

/**
 * Atomically claims the next runnable job for a worker. Jobs belonging to deleted/stale documents or to
 * organizations that switched AI off are never handed out.
 */
async function claim({ workerId, pipelineVersion }) {
  if (pipelineVersion !== PIPELINE) return null; // a worker built for another pipeline gets nothing
  await recoverStale();
  for (let guard = 0; guard < 25; guard += 1) {
    const now = new Date();
    const lockToken = crypto.randomBytes(24).toString('hex');
    // eslint-disable-next-line no-await-in-loop
    const job = await DocumentIngestionJob.findOneAndUpdate(
      { pipelineVersion: PIPELINE, status: { $in: [S.QUEUED, S.FAILED] }, nextRunAt: { $lte: now } },
      {
        $set: { status: S.PROCESSING, lockToken, lockedBy: String(workerId).slice(0, 80), lockExpiresAt: new Date(now.getTime() + env.AI_INGEST_LEASE_SECONDS * 1000), startedAt: now, heartbeatAt: now, finishedAt: null },
        $inc: { attempts: 1 },
      },
      { sort: { nextRunAt: 1 }, returnDocument: 'after' },
    ).select('+lockToken');
    if (!job) return null;

    // eslint-disable-next-line no-await-in-loop
    if (!(await isAiEnabled(job.organization))) {
      // Not our business while AI is off: put it back untouched (attempt not counted) and look again later.
      // eslint-disable-next-line no-await-in-loop
      await DocumentIngestionJob.updateOne(
        { _id: job._id, lockToken },
        { $set: { status: S.QUEUED, nextRunAt: new Date(now.getTime() + 5 * 60 * 1000), ...UNLOCK }, $inc: { attempts: -1 } },
      );
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const stale = await staleReason(job);
    if (stale) {
      // eslint-disable-next-line no-await-in-loop
      await skipJob({ job, reason: stale });
      continue;
    }
    return job;
  }
  return null;
}

/** Extends the lease. Returns { ok, reason } - reason is set when the job must be abandoned. */
async function heartbeat({ jobId, lockToken }) {
  const now = new Date();
  const job = await DocumentIngestionJob.findOne({ _id: jobId }).select('+lockToken');
  if (!job || job.status !== S.PROCESSING || !safeEqual(job.lockToken, lockToken) || job.lockExpiresAt <= now) return { ok: false, reason: 'LOCK_LOST' };
  const stale = await staleReason(job);
  if (stale) {
    await skipJob({ job, reason: stale });
    return { ok: false, reason: stale };
  }
  if (now - job.startedAt > env.AI_INGEST_MAX_PROCESSING_SECONDS * 1000) return { ok: false, reason: 'LOCK_LOST' }; // runaway: let it expire
  const updated = await DocumentIngestionJob.updateOne(lockFilter(job._id, lockToken, now), {
    $set: { lockExpiresAt: new Date(now.getTime() + env.AI_INGEST_LEASE_SECONDS * 1000), heartbeatAt: now },
  });
  return updated.modifiedCount === 1 ? { ok: true } : { ok: false, reason: 'LOCK_LOST' };
}

// ---------------------------------------------------------------------------------------------------------------
// Administration

async function findJob(organization, jobId) {
  if (!/^[a-f0-9]{24}$/i.test(String(jobId))) throw new AppError('Job not found', 404, 'NOT_FOUND');
  const job = await DocumentIngestionJob.findOne({ _id: jobId, organization });
  if (!job) throw new AppError('Job not found', 404, 'NOT_FOUND'); // another organization's job looks identical to a missing one
  return job;
}

const RETRYABLE = [S.DEAD, S.FAILED, S.SKIPPED];
const NEVER_RETRY = [SKIP_REASONS.SUPERSEDED, SKIP_REASONS.DOCUMENT_DELETED];

/** Admin retry: back to queued with a fresh budget. Only for the document's CURRENT version. */
async function retryJob({ organization, jobId }) {
  const job = await findJob(organization, jobId);
  if (!RETRYABLE.includes(job.status) || NEVER_RETRY.includes(job.reason)) {
    throw new AppError('This job cannot be retried', 409, 'INGESTION_NOT_RETRYABLE');
  }
  const stale = await staleReason(job);
  if (stale) throw new AppError('This version of the document is no longer current', 409, 'INGESTION_NOT_RETRYABLE');
  const state = initialState({ extension: job.extension, size: job.size });
  const now = new Date();
  const updated = await DocumentIngestionJob.findOneAndUpdate(
    { _id: job._id, status: { $in: RETRYABLE } },
    { $set: { status: state.status, reason: state.reason, attempts: 0, maxAttempts: env.AI_INGEST_MAX_ATTEMPTS, nextRunAt: now, finishedAt: state.status === S.SKIPPED ? now : null, stats: null, source: 'admin', ...UNLOCK } },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('This job cannot be retried', 409, 'INGESTION_NOT_RETRYABLE');
  return updated;
}

async function listJobs({ organization, status, reason, page = 1, limit = 25 }) {
  const filter = { organization };
  if (status) filter.status = status;
  if (reason) filter.reason = reason;
  const [items, total] = await Promise.all([
    DocumentIngestionJob.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit),
    DocumentIngestionJob.countDocuments(filter),
  ]);
  return { items, total };
}

async function summarize(organization) {
  const rows = await DocumentIngestionJob.aggregate([{ $match: { organization } }, { $group: { _id: { status: '$status', reason: '$reason' }, count: { $sum: 1 } } }]);
  const byStatus = Object.fromEntries(Object.values(S).map((s) => [s, 0]));
  const skippedByReason = {};
  const failedByReason = {};
  for (const row of rows) {
    byStatus[row._id.status] += row.count;
    if (row._id.status === S.SKIPPED && row._id.reason) skippedByReason[row._id.reason] = row.count;
    if ([S.FAILED, S.DEAD].includes(row._id.status) && row._id.reason) failedByReason[row._id.reason] = (failedByReason[row._id.reason] || 0) + row.count;
  }
  return { byStatus, skippedByReason, failedByReason, pipelineVersion: PIPELINE };
}

module.exports = {
  backoffMs,
  claim,
  enqueue,
  enqueueCurrentVersion,
  failJob,
  findJob,
  heartbeat,
  idString,
  initialState,
  isAiEnabled,
  listJobs,
  lockFilter,
  recoverStale,
  retryJob,
  reviveDeleted,
  safeEqual,
  skipJob,
  staleReason,
  summarize,
};
