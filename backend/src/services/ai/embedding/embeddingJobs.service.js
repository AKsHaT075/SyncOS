const crypto = require('crypto');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const Document = require('../../../models/Document');
const DocumentChunk = require('../../../models/DocumentChunk');
const DocumentIngestionJob = require('../../../models/DocumentIngestionJob');
const EmbeddingJob = require('../../../models/EmbeddingJob');
const { INGESTION_PIPELINE_VERSION: INGEST_PIPELINE, INGESTION_STATUS } = require('../../../constants/ingestion.constants');
const { ANY_PIPELINE, EMBEDDING_KIND: KIND, EMBEDDING_STATUS: S, FAIL_REASONS, SKIP_REASONS } = require('../../../constants/embedding.constants');
const { isAiEnabled, safeEqual } = require('../ingestion/ingestionJobs.service');
const spaces = require('./embeddingSpaces.service');

/**
 * Durable embedding job state machine. Same discipline as ingestion: MongoDB is the truth, every transition is ONE
 * conditional update, a lease (lockToken + expiry) is extended by heartbeats and fences stale workers.
 *
 *   embed:  queued -> processing -> completed | skipped | failed -(backoff)-> ... -> dead
 *   purge:  same states; a purge removes a document's vectors from one space and is idempotent
 *
 * Node never talks to the vector database. It decides WHAT must exist (jobs) and checks what the worker reports.
 */

const UNLOCK = { lockedBy: null, lockExpiresAt: null };

function backoffMs(attempts) {
  const base = env.AI_EMBEDDING_BACKOFF_BASE_SECONDS * 1000;
  const raw = Math.min(env.AI_EMBEDDING_BACKOFF_MAX_SECONDS * 1000, base * 2 ** Math.max(0, attempts - 1));
  return Math.round(raw / 2 + Math.random() * (raw / 2));
}

const lockFilter = (id, lockToken, now = new Date()) => ({ _id: id, status: S.PROCESSING, lockToken, lockExpiresAt: { $gt: now } });

// ---------------------------------------------------------------------------------------------------------------
// Enqueue

/** Embed one document version into one space. Idempotent; revives a row that was skipped because the document was trashed. */
async function enqueueEmbed({ organization, document, version, spaceId, ingestionPipeline = INGEST_PIPELINE, source = 'ingestion' }) {
  const now = new Date();
  const filter = { organization, document, kind: KIND.EMBED, version, ingestionPipeline, spaceId };
  try {
    const r = await EmbeddingJob.updateOne(
      filter,
      { $setOnInsert: { ...filter, status: S.QUEUED, source, attempts: 0, maxAttempts: env.AI_EMBEDDING_MAX_ATTEMPTS, nextRunAt: now } },
      { upsert: true },
    );
    if (r.upsertedCount === 0) {
      await EmbeddingJob.updateOne(
        { ...filter, status: S.SKIPPED, reason: { $in: [SKIP_REASONS.DOCUMENT_DELETED, SKIP_REASONS.INGESTION_NOT_INDEXED, SKIP_REASONS.NO_CHUNKS] } },
        { $set: { status: S.QUEUED, reason: null, attempts: 0, nextRunAt: now, finishedAt: null, source, ...UNLOCK } },
      );
    }
    return { created: r.upsertedCount > 0 };
  } catch (error) {
    if (error.code === 11000) return { created: false };
    throw error;
  }
}

/** Embed into every space that is currently being served or built. */
async function enqueueEmbedAllSpaces({ organization, document, version, source }) {
  if (!(await isAiEnabled(organization))) return [];
  const ids = await spaces.activeSpaceIds();
  const out = [];
  for (const spaceId of ids) out.push(await enqueueEmbed({ organization, document, version, spaceId, source })); // eslint-disable-line no-await-in-loop
  return out;
}

/**
 * Ask for a document's vectors in one space to be removed (all versions, or all but keepVersion). Re-asking bumps the
 * `generation`, so a purge that was already running cannot swallow a newer request.
 */
async function enqueuePurge({ organization, document, spaceId, keepVersion = null, source = 'lifecycle' }) {
  const now = new Date();
  const filter = { organization, document, kind: KIND.PURGE, version: 0, ingestionPipeline: ANY_PIPELINE, spaceId };
  try {
    const r = await EmbeddingJob.updateOne(
      filter,
      { $setOnInsert: { ...filter, status: S.QUEUED, source, attempts: 0, maxAttempts: env.AI_EMBEDDING_MAX_ATTEMPTS, nextRunAt: now, keepVersion, generation: 1 } },
      { upsert: true },
    );
    if (r.upsertedCount > 0) return { created: true };
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  // exists: idle -> requeue; running -> just bump the generation so its result does not complete the newer request
  await EmbeddingJob.updateOne({ ...filter, status: { $ne: S.PROCESSING } }, { $set: { status: S.QUEUED, reason: null, attempts: 0, nextRunAt: now, finishedAt: null, keepVersion, source, ...UNLOCK }, $inc: { generation: 1 } });
  await EmbeddingJob.updateOne({ ...filter, status: S.PROCESSING }, { $set: { keepVersion }, $inc: { generation: 1 } });
  return { created: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Transitions

async function failJob({ job, reason }) {
  const now = new Date();
  const dead = job.attempts >= job.maxAttempts;
  return EmbeddingJob.findOneAndUpdate(
    lockFilter(job._id, job.lockToken, now),
    { $set: { status: dead ? S.DEAD : S.FAILED, reason, nextRunAt: dead ? now : new Date(now.getTime() + backoffMs(job.attempts)), finishedAt: dead ? now : null, ...UNLOCK } },
    { returnDocument: 'after' },
  );
}

async function skipJob({ job, reason, fenced = true }) {
  const now = new Date();
  const filter = fenced ? lockFilter(job._id, job.lockToken, now) : { _id: job._id, status: { $in: [S.PROCESSING, S.QUEUED, S.FAILED] } };
  return EmbeddingJob.findOneAndUpdate(filter, { $set: { status: S.SKIPPED, reason, finishedAt: now, ...UNLOCK } }, { returnDocument: 'after' });
}

async function recoverStale(now = new Date()) {
  const base = { status: S.PROCESSING, lockExpiresAt: { $lt: now } };
  const dead = await EmbeddingJob.updateMany({ ...base, $expr: { $gte: ['$attempts', '$maxAttempts'] } }, { $set: { status: S.DEAD, reason: FAIL_REASONS.LOCK_EXPIRED, finishedAt: now, ...UNLOCK } });
  const stale = await EmbeddingJob.find({ ...base, $expr: { $lt: ['$attempts', '$maxAttempts'] } }).select('_id attempts').lean();
  let retried = 0;
  for (const job of stale) {
    // eslint-disable-next-line no-await-in-loop
    const r = await EmbeddingJob.updateOne({ _id: job._id, ...base }, { $set: { status: S.FAILED, reason: FAIL_REASONS.LOCK_EXPIRED, nextRunAt: new Date(now.getTime() + backoffMs(job.attempts)), ...UNLOCK } });
    retried += r.modifiedCount;
  }
  return { dead: dead.modifiedCount, retried };
}

/** Why an embed job no longer applies to the LIVE document, or null. Also checks ingestion produced these chunks. */
async function staleReason(job) {
  const doc = await Document.findOne({ _id: job.document, organization: job.organization }).select('deletedAt currentVersion').lean();
  if (!doc || doc.deletedAt) return SKIP_REASONS.DOCUMENT_DELETED;
  if (doc.currentVersion !== job.version) return SKIP_REASONS.SUPERSEDED;
  const ingest = await DocumentIngestionJob.findOne({ organization: job.organization, document: job.document, version: job.version, pipelineVersion: job.ingestionPipeline }).select('status').lean();
  if (!ingest || ingest.status !== INGESTION_STATUS.INDEXED) return SKIP_REASONS.INGESTION_NOT_INDEXED;
  return null;
}

/**
 * Atomically claim the next job for a worker that produces `spaceId`. Purges go first (privacy before convenience).
 * Embed jobs for deleted/stale documents, for spaces nobody uses any more, or for organizations that switched AI
 * off are never handed out.
 */
async function claim({ workerId, spaceId, ingestionPipeline }) {
  if (ingestionPipeline !== INGEST_PIPELINE || typeof spaceId !== 'string') return null;
  await recoverStale();
  for (let guard = 0; guard < 25; guard += 1) {
    const now = new Date();
    const lockToken = crypto.randomBytes(24).toString('hex');
    // eslint-disable-next-line no-await-in-loop
    const job = await EmbeddingJob.findOneAndUpdate(
      { spaceId, status: { $in: [S.QUEUED, S.FAILED] }, nextRunAt: { $lte: now }, $or: [{ kind: KIND.PURGE }, { kind: KIND.EMBED, ingestionPipeline }] },
      {
        $set: { status: S.PROCESSING, lockToken, lockedBy: String(workerId).slice(0, 80), lockExpiresAt: new Date(now.getTime() + env.AI_EMBEDDING_LEASE_SECONDS * 1000), startedAt: now, heartbeatAt: now, finishedAt: null },
        $inc: { attempts: 1 },
      },
      { sort: { kind: -1, nextRunAt: 1 }, returnDocument: 'after' }, // 'purge' sorts after 'embed' descending => purges first
    ).select('+lockToken');
    if (!job) return null;
    if (job.kind === KIND.PURGE) return job;

    // eslint-disable-next-line no-await-in-loop
    if (!(await isAiEnabled(job.organization))) {
      // eslint-disable-next-line no-await-in-loop
      await EmbeddingJob.updateOne({ _id: job._id, lockToken }, { $set: { status: S.QUEUED, nextRunAt: new Date(now.getTime() + 5 * 60 * 1000), ...UNLOCK }, $inc: { attempts: -1 } });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (!(await spaces.isServedSpace(spaceId))) {
      // eslint-disable-next-line no-await-in-loop
      await skipJob({ job, reason: SKIP_REASONS.SPACE_RETIRED });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const stale = await staleReason(job);
    if (stale) {
      // eslint-disable-next-line no-await-in-loop
      await skipJob({ job, reason: stale });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const chunkCount = await DocumentChunk.countDocuments({ organization: job.organization, document: job.document, version: job.version, pipelineVersion: job.ingestionPipeline });
    if (chunkCount === 0) {
      // eslint-disable-next-line no-await-in-loop
      await skipJob({ job, reason: SKIP_REASONS.NO_CHUNKS });
      continue;
    }
    job.chunkCount = chunkCount;
    return job;
  }
  return null;
}

async function heartbeat({ jobId, lockToken }) {
  const now = new Date();
  const job = await EmbeddingJob.findById(jobId).select('+lockToken');
  if (!job || job.status !== S.PROCESSING || !safeEqual(job.lockToken, lockToken) || job.lockExpiresAt <= now) return { ok: false, reason: 'LOCK_LOST' };
  if (job.kind === KIND.EMBED) {
    const stale = await staleReason(job);
    if (stale) {
      await skipJob({ job, reason: stale });
      await onEmbedAbandoned(job, stale);
      return { ok: false, reason: stale };
    }
  }
  if (now - job.startedAt > env.AI_EMBEDDING_MAX_PROCESSING_SECONDS * 1000) return { ok: false, reason: 'LOCK_LOST' };
  const r = await EmbeddingJob.updateOne(lockFilter(job._id, lockToken, now), { $set: { lockExpiresAt: new Date(now.getTime() + env.AI_EMBEDDING_LEASE_SECONDS * 1000), heartbeatAt: now } });
  return r.modifiedCount === 1 ? { ok: true } : { ok: false, reason: 'LOCK_LOST' };
}

/**
 * A worker may already have written vectors for a version that turned out to be stale (or whose document was trashed):
 * make sure they are removed. (Deleting an empty set is a no-op, so this is always safe.)
 */
async function onEmbedAbandoned(job, reason) {
  if (reason === SKIP_REASONS.DOCUMENT_DELETED) {
    await enqueuePurge({ organization: job.organization, document: job.document, spaceId: job.spaceId, keepVersion: null, source: 'abandoned' });
    return;
  }
  if (reason === SKIP_REASONS.SUPERSEDED) {
    const doc = await Document.findOne({ _id: job.document, organization: job.organization }).select('currentVersion').lean();
    await enqueuePurge({ organization: job.organization, document: job.document, spaceId: job.spaceId, keepVersion: doc ? doc.currentVersion : null, source: 'abandoned' });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Administration

async function findJob(organization, jobId) {
  if (!/^[a-f0-9]{24}$/i.test(String(jobId))) throw new AppError('Job not found', 404, 'NOT_FOUND');
  const job = await EmbeddingJob.findOne({ _id: jobId, organization });
  if (!job) throw new AppError('Job not found', 404, 'NOT_FOUND');
  return job;
}

const RETRYABLE = [S.DEAD, S.FAILED, S.SKIPPED];
const NEVER_RETRY = [SKIP_REASONS.SUPERSEDED, SKIP_REASONS.DOCUMENT_DELETED, SKIP_REASONS.SPACE_RETIRED];

async function retryJob({ organization, jobId }) {
  const job = await findJob(organization, jobId);
  if (!RETRYABLE.includes(job.status) || NEVER_RETRY.includes(job.reason)) throw new AppError('This job cannot be retried', 409, 'EMBEDDING_NOT_RETRYABLE');
  if (job.kind === KIND.EMBED) {
    const stale = await staleReason(job);
    if (stale === SKIP_REASONS.DOCUMENT_DELETED || stale === SKIP_REASONS.SUPERSEDED) throw new AppError('This version of the document is no longer current', 409, 'EMBEDDING_NOT_RETRYABLE');
    if (!(await spaces.isServedSpace(job.spaceId))) throw new AppError('This embedding space is no longer in use', 409, 'EMBEDDING_NOT_RETRYABLE');
  }
  const now = new Date();
  const updated = await EmbeddingJob.findOneAndUpdate(
    { _id: job._id, status: { $in: RETRYABLE } },
    { $set: { status: S.QUEUED, reason: null, attempts: 0, maxAttempts: env.AI_EMBEDDING_MAX_ATTEMPTS, nextRunAt: now, finishedAt: null, source: 'admin', ...UNLOCK } },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('This job cannot be retried', 409, 'EMBEDDING_NOT_RETRYABLE');
  return updated;
}

async function listJobs({ organization, status, reason, kind, spaceId, page = 1, limit = 25 }) {
  const filter = { organization };
  for (const [k, v] of Object.entries({ status, reason, kind, spaceId })) if (v) filter[k] = v;
  const [items, total] = await Promise.all([EmbeddingJob.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit), EmbeddingJob.countDocuments(filter)]);
  return { items, total };
}

async function summarize(organization) {
  const rows = await EmbeddingJob.aggregate([{ $match: { organization } }, { $group: { _id: { kind: '$kind', status: '$status', spaceId: '$spaceId' }, count: { $sum: 1 } } }]);
  const empty = () => Object.fromEntries(Object.values(S).map((s) => [s, 0]));
  const bySpace = {};
  for (const r of rows) {
    const space = (bySpace[r._id.spaceId] ||= { embed: empty(), purge: empty() });
    space[r._id.kind][r._id.status] += r.count;
  }
  return { bySpace };
}

module.exports = {
  backoffMs,
  claim,
  enqueueEmbed,
  enqueueEmbedAllSpaces,
  enqueuePurge,
  failJob,
  findJob,
  heartbeat,
  listJobs,
  lockFilter,
  onEmbedAbandoned,
  recoverStale,
  retryJob,
  skipJob,
  staleReason,
  summarize,
};
