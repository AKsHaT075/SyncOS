const { z } = require('zod');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const Document = require('../../../models/Document');
const DocumentChunk = require('../../../models/DocumentChunk');
const EmbeddingJob = require('../../../models/EmbeddingJob');
const { EMBEDDING_KIND: KIND, EMBEDDING_STATUS: S, FAIL_REASONS, LIMITS, WORKER_FAIL_REASONS } = require('../../../constants/embedding.constants');
const { isAiEnabled, safeEqual } = require('../ingestion/ingestionJobs.service');
const jobs = require('./embeddingJobs.service');
const spaces = require('./embeddingSpaces.service');

/**
 * What the embedding worker may do: claim -> (heartbeat) -> read the chunk text of ITS claimed job -> report.
 * Text is served only for a claimed embed job whose lease is live, after Node re-checks the live document (exists in
 * THIS organization, not trashed, still the job's version, extraction `indexed`, AI still enabled). Vectors never pass
 * through Node: the worker writes them to the vector store and reports only counts, a digest and the space it used.
 */

const lockLost = () => new AppError('Lock lost', 409, 'LOCK_LOST');
const gone = (reason) => new AppError('Job is no longer current', 409, reason || 'SUPERSEDED');

function present(job) {
  return {
    id: job._id.toString(),
    kind: job.kind,
    organization: job.organization.toString(), // Python needs the tenant for its vector-store filters; it is not a secret
    document: job.document.toString(),
    version: job.version,
    ingestionPipeline: job.ingestionPipeline,
    spaceId: job.spaceId,
    keepVersion: job.keepVersion,
    generation: job.generation,
    chunkCount: job.chunkCount || 0,
    lockToken: job.lockToken,
    leaseSeconds: env.AI_EMBEDDING_LEASE_SECONDS,
    attempt: job.attempts,
  };
}

async function claimJob({ workerId, spaceId, ingestionPipeline }) {
  const job = await jobs.claim({ workerId, spaceId, ingestionPipeline });
  return { job: job ? present(job) : null };
}

async function heartbeat({ jobId, lockToken }) {
  const r = await jobs.heartbeat({ jobId, lockToken });
  if (!r.ok) throw r.reason === 'LOCK_LOST' ? lockLost() : gone(r.reason);
  return { ok: true, leaseSeconds: env.AI_EMBEDDING_LEASE_SECONDS };
}

async function loadOwnedJob(jobId, lockToken) {
  if (!/^[a-f0-9]{24}$/i.test(String(jobId)) || typeof lockToken !== 'string') throw lockLost();
  const job = await EmbeddingJob.findById(jobId).select('+lockToken');
  if (!job || !safeEqual(job.lockToken, lockToken)) throw lockLost();
  return job;
}

/** A page of the claimed job's chunks (text included), after every live check. */
async function chunksPage({ jobId, lockToken, after, limit }) {
  const job = await loadOwnedJob(jobId, lockToken);
  if (job.kind !== KIND.EMBED || job.status !== S.PROCESSING || job.lockExpiresAt <= new Date()) throw lockLost();
  if (!(await isAiEnabled(job.organization))) throw gone('AI_DISABLED');
  const stale = await jobs.staleReason(job);
  if (stale) {
    await jobs.skipJob({ job, reason: stale });
    await jobs.onEmbedAbandoned(job, stale);
    throw gone(stale);
  }
  const cap = Math.min(Math.max(1, Number(limit) || 1), LIMITS.maxPageChunks);
  const afterIndex = Number.isInteger(Number(after)) ? Number(after) : -1;
  // organization is part of EVERY lookup: a job can only ever read its own tenant's chunks
  const rows = await DocumentChunk.find({ organization: job.organization, document: job.document, version: job.version, pipelineVersion: job.ingestionPipeline, chunkIndex: { $gt: afterIndex } })
    .sort({ chunkIndex: 1 })
    .limit(cap + 1)
    .select('chunkIndex textHash text')
    .lean();
  const more = rows.length > cap;
  let chars = 0;
  const out = [];
  for (const row of rows.slice(0, cap)) {
    chars += row.text.length;
    if (out.length > 0 && chars > LIMITS.maxPageChars) break;
    out.push({ index: row.chunkIndex, textHash: row.textHash, text: row.text });
  }
  const truncated = out.length < Math.min(rows.length, cap);
  return { chunks: out, next: more || truncated ? out[out.length - 1].index : null };
}

// ---------------------------------------------------------------------------------------------------------------

const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('failed'), reason: z.enum(WORKER_FAIL_REASONS) }).strict(),
  z
    .object({
      status: z.literal('embedded'),
      spaceId: z.string().regex(/^[a-f0-9]{12}$/),
      model: z.string().max(200),
      revision: z.string().max(100),
      dimensions: z.number().int().min(1).max(8192),
      count: z.number().int().min(1).max(10000),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      embedded: z.number().int().min(0).max(10000).optional(),
    })
    .strict(),
  z.object({ status: z.literal('completed'), deleted: z.number().int().min(0).max(10_000_000), generation: z.number().int().min(0) }).strict(),
]);

async function submitResult({ jobId, lockToken, result: raw }) {
  const job = await loadOwnedJob(jobId, lockToken);

  // A result we already accepted, re-sent because the response was lost: acknowledge, change nothing.
  if (job.status === S.COMPLETED && job.lockedBy === null && job.finishedAt) {
    const again = resultSchema.safeParse(raw);
    if (again.success && ['embedded', 'completed'].includes(again.data.status)) return { ok: true, status: job.status, duplicate: true };
    throw lockLost();
  }
  if (job.status !== S.PROCESSING || job.lockExpiresAt <= new Date()) throw lockLost();

  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) {
    await jobs.failJob({ job, reason: FAIL_REASONS.INTERNAL_ERROR });
    throw new AppError('Invalid result', 400, 'INVALID_RESULT');
  }
  const result = parsed.data;

  if (result.status === 'failed') {
    await jobs.failJob({ job, reason: result.reason });
    return { ok: true, status: 'failed' };
  }

  if (job.kind === KIND.PURGE) {
    if (result.status !== 'completed') {
      await jobs.failJob({ job, reason: FAIL_REASONS.RESULT_MISMATCH });
      throw new AppError('Result does not match the job', 400, 'INVALID_RESULT');
    }
    return completePurge(job, result);
  }
  if (result.status !== 'embedded') {
    await jobs.failJob({ job, reason: FAIL_REASONS.RESULT_MISMATCH });
    throw new AppError('Result does not match the job', 400, 'INVALID_RESULT');
  }
  return completeEmbed(job, lockToken, result);
}

async function completeEmbed(job, lockToken, result) {
  const descriptor = await spaces.descriptorOf(job.spaceId);
  const chunks = await DocumentChunk.find({ organization: job.organization, document: job.document, version: job.version, pipelineVersion: job.ingestionPipeline }).sort({ chunkIndex: 1 }).select('textHash').lean();
  const expectedDigest = spaces.digestOf(chunks.map((c) => c.textHash));
  const consistent =
    descriptor &&
    result.spaceId === job.spaceId &&
    result.model === descriptor.model &&
    result.revision === descriptor.revision &&
    result.dimensions === descriptor.dimensions &&
    result.count === chunks.length &&
    chunks.length > 0 &&
    result.digest === expectedDigest;
  if (!consistent) {
    // wrong model/revision/dimensions, or it embedded a different chunk set than the one Node holds: never accept it
    await jobs.failJob({ job, reason: FAIL_REASONS.RESULT_MISMATCH });
    throw new AppError('Result does not match the embedding space or the document\'s chunks', 409, 'RESULT_MISMATCH');
  }

  const stale = await jobs.staleReason(job);
  if (stale) {
    await jobs.skipJob({ job, reason: stale });
    await jobs.onEmbedAbandoned(job, stale); // vectors may have been written: remove them
    throw gone(stale);
  }

  const now = new Date();
  const done = await EmbeddingJob.findOneAndUpdate(
    jobs.lockFilter(job._id, lockToken, now),
    { $set: { status: S.COMPLETED, reason: null, chunkCount: chunks.length, digest: result.digest, embeddedAt: now, lastVerifiedAt: now, finishedAt: now, lockedBy: null, lockExpiresAt: null } },
    { returnDocument: 'after' },
  );
  if (!done) throw lockLost();

  // The document may have changed in the instant between the check and the commit: if so, undo.
  const after = await jobs.staleReason(job);
  if (after) {
    await EmbeddingJob.updateOne({ _id: job._id, status: S.COMPLETED }, { $set: { status: S.SKIPPED, reason: after, finishedAt: new Date() } });
    await jobs.onEmbedAbandoned(job, after);
    throw gone(after);
  }
  await retireOlderVersions(job);
  return { ok: true, status: 'completed', chunks: chunks.length };
}

/** The current version is embedded: older versions' vectors in this space are obsolete and must go. */
async function retireOlderVersions(job) {
  const older = await EmbeddingJob.find({ organization: job.organization, document: job.document, kind: KIND.EMBED, spaceId: job.spaceId, version: { $ne: job.version }, status: { $ne: S.SKIPPED } }).select('_id').lean();
  if (older.length === 0 && job.version <= 1) return;
  await EmbeddingJob.updateMany({ _id: { $in: older.map((o) => o._id) }, status: { $in: [S.QUEUED, S.FAILED, S.COMPLETED, S.DEAD] } }, { $set: { status: S.SKIPPED, reason: 'SUPERSEDED', finishedAt: new Date() } });
  await jobs.enqueuePurge({ organization: job.organization, document: job.document, spaceId: job.spaceId, keepVersion: job.version, source: 'version' });
}

async function completePurge(job, result) {
  const now = new Date();
  if (result.generation !== job.generation) {
    // a newer purge request arrived while this one ran: run again rather than pretend it was covered
    const re = await EmbeddingJob.findOneAndUpdate(jobs.lockFilter(job._id, job.lockToken, now), { $set: { status: S.QUEUED, nextRunAt: now, attempts: 0, ...{ lockedBy: null, lockExpiresAt: null } } }, { returnDocument: 'after' });
    if (!re) throw lockLost();
    return { ok: true, status: 'requeued' };
  }
  const done = await EmbeddingJob.findOneAndUpdate(
    jobs.lockFilter(job._id, job.lockToken, now),
    { $set: { status: S.COMPLETED, reason: null, finishedAt: now, lockedBy: null, lockExpiresAt: null } },
    { returnDocument: 'after' },
  );
  if (!done) throw lockLost();

  // Convergence: if the document is LIVE and extracted, a purge that raced with a restore/re-embed may have removed
  // vectors that should exist. Put its embed rows for this space back to work (embedding is idempotent).
  const doc = await Document.findOne({ _id: job.document, organization: job.organization }).select('deletedAt currentVersion').lean();
  // Only when the purge COULD have removed the current version's vectors. A purge that keeps the current version (the
  // routine clean-up after a new version was embedded) must not re-queue anything - otherwise embed -> purge -> embed
  // would loop forever.
  const couldHaveHitCurrent = job.keepVersion === null || job.keepVersion === undefined || (doc && job.keepVersion !== doc.currentVersion);
  if (doc && !doc.deletedAt && couldHaveHitCurrent) {
    await EmbeddingJob.updateMany({ organization: job.organization, document: job.document, kind: KIND.EMBED, spaceId: job.spaceId, version: doc.currentVersion, status: S.COMPLETED }, { $set: { status: S.QUEUED, nextRunAt: now, attempts: 0, source: 'verify', finishedAt: null } });
  }
  if (!doc) {
    // the document no longer exists at all: once its vectors are gone, nothing about it should remain
    await EmbeddingJob.deleteMany({ organization: job.organization, document: job.document, spaceId: job.spaceId });
  }
  return { ok: true, status: 'completed', deleted: result.deleted };
}

module.exports = { chunksPage, claimJob, heartbeat, resultSchema, submitResult };
