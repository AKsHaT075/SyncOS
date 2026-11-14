const crypto = require('crypto');
const { z } = require('zod');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const Document = require('../../../models/Document');
const DocumentChunk = require('../../../models/DocumentChunk');
const DocumentIngestionJob = require('../../../models/DocumentIngestionJob');
const DocumentVersion = require('../../../models/DocumentVersion');
const { getStorage } = require('../../../storage');
const {
  FAIL_REASONS,
  INGESTION_PIPELINE_VERSION: PIPELINE,
  INGESTION_STATUS: S,
  LIMITS,
  WORKER_FAIL_REASONS,
  WORKER_SKIP_REASONS,
} = require('../../../constants/ingestion.constants');
const jobs = require('./ingestionJobs.service');

/**
 * What the worker may do, and nothing else:  claim -> (heartbeat) -> download its own claimed document -> submit.
 * Every call is tied to a job + lock token. The worker cannot name a document, cannot read an unclaimed job, and
 * Node re-checks the live document (exists in THIS org, not trashed, still the same version and checksum) on each step.
 */

const lockLost = () => new AppError('Lock lost', 409, 'LOCK_LOST');
const gone = (reason) => new AppError('Job is no longer current', 409, reason || 'SUPERSEDED');

function present(job) {
  return {
    id: job._id.toString(),
    format: job.format,
    size: job.size,
    sha256: job.checksum,
    lockToken: job.lockToken,
    leaseSeconds: env.AI_INGEST_LEASE_SECONDS,
    attempt: job.attempts,
    pipelineVersion: job.pipelineVersion,
  };
}

async function claimJob({ workerId, pipelineVersion }) {
  const job = await jobs.claim({ workerId, pipelineVersion });
  return { job: job ? present(job) : null };
}

async function heartbeat({ jobId, lockToken }) {
  const result = await jobs.heartbeat({ jobId, lockToken });
  if (!result.ok) throw result.reason === 'LOCK_LOST' ? lockLost() : gone(result.reason);
  return { ok: true, leaseSeconds: env.AI_INGEST_LEASE_SECONDS };
}

async function loadOwnedJob(jobId, lockToken) {
  if (!/^[a-f0-9]{24}$/i.test(String(jobId)) || typeof lockToken !== 'string') throw lockLost();
  const job = await DocumentIngestionJob.findById(jobId).select('+lockToken');
  if (!job || !jobs.safeEqual(job.lockToken, lockToken)) throw lockLost();
  return job;
}

/**
 * Opens the bytes of the claimed job's version. Returns { stream, size }. The caller pipes it to the response.
 */
async function openContent({ jobId, lockToken }) {
  const job = await loadOwnedJob(jobId, lockToken);
  if (job.status !== S.PROCESSING || job.lockExpiresAt <= new Date()) throw lockLost();

  const stale = await jobs.staleReason(job);
  if (stale) {
    await jobs.skipJob({ job, reason: stale });
    throw gone(stale);
  }
  // organization is part of EVERY lookup: a job can never address another tenant's blob.
  const version = await DocumentVersion.findOne({ organization: job.organization, document: job.document, version: job.version }).select('+storageKey checksum size');
  if (!version || version.checksum !== job.checksum) {
    await jobs.skipJob({ job, reason: 'SUPERSEDED' });
    throw gone('SUPERSEDED');
  }
  const storage = getStorage();
  const stat = await storage.stat(version.storageKey).catch(() => null);
  if (!stat) {
    await jobs.failJob({ job, reason: FAIL_REASONS.STORAGE_MISSING });
    throw gone(FAIL_REASONS.STORAGE_MISSING);
  }
  return { stream: storage.createReadStream(version.storageKey), size: stat.size };
}

// ---------------------------------------------------------------------------------------------------------------
// Result validation

const int = z.number().int().min(0).max(10_000_000);
const locationSchema = z
  .object({
    pageStart: int.optional(),
    pageEnd: int.optional(),
    headingPath: z.array(z.string().max(LIMITS.maxHeadingChars)).max(LIMITS.maxHeadingDepth).optional(),
    sheet: z.string().max(200).optional(),
    rowStart: int.optional(),
    rowEnd: int.optional(),
    slideStart: int.optional(),
    slideEnd: int.optional(),
    charStart: int.optional(),
    charEnd: int.optional(),
  })
  .strict();

const chunkSchema = z
  .object({
    index: int,
    text: z.string().min(1).max(LIMITS.maxChunkChars),
    textHash: z.string().regex(/^[a-f0-9]{64}$/),
    tokenEstimate: z.number().int().min(1).max(100_000),
    location: locationSchema,
  })
  .strict();

const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('failed'), reason: z.enum(WORKER_FAIL_REASONS) }).strict(),
  z.object({ status: z.literal('skipped'), reason: z.enum(WORKER_SKIP_REASONS), format: z.string().max(10).optional(), pipelineVersion: z.string().max(20).optional() }).strict(),
  z
    .object({
      status: z.literal('indexed'),
      format: z.string().max(10),
      pipelineVersion: z.literal(PIPELINE),
      stats: z.record(z.string().max(40), z.number().finite()).default({}),
      chunks: z.array(chunkSchema).min(1).max(LIMITS.maxChunksPerDocument),
    })
    .strict(),
]);

function validateChunks(job, result) {
  if (result.format !== job.format) throw new AppError('Format mismatch', 400, 'INVALID_RESULT');
  let chars = 0;
  result.chunks.forEach((chunk, i) => {
    chars += chunk.text.length;
    if (chunk.index !== i) throw new AppError('Chunk indexes must be contiguous from 0', 400, 'INVALID_RESULT');
    if (crypto.createHash('sha256').update(chunk.text, 'utf8').digest('hex') !== chunk.textHash) throw new AppError('Chunk hash mismatch', 400, 'INVALID_RESULT');
  });
  if (chars > LIMITS.maxResultChars) throw new AppError('Result too large', 413, 'INVALID_RESULT');
}

/** Idempotent: re-running with the same input rewrites identical rows. Never leaves stale tail chunks. */
async function writeChunks(job, chunks) {
  const base = { organization: job.organization, document: job.document, version: job.version, pipelineVersion: job.pipelineVersion };
  for (let start = 0; start < chunks.length; start += 500) {
    const ops = chunks.slice(start, start + 500).map((chunk) => ({
      updateOne: {
        filter: { ...base, chunkIndex: chunk.index },
        update: { $set: { text: chunk.text, textHash: chunk.textHash, tokenEstimate: chunk.tokenEstimate, location: chunk.location }, $setOnInsert: { createdAt: new Date() } },
        upsert: true,
      },
    }));
    // eslint-disable-next-line no-await-in-loop
    await DocumentChunk.bulkWrite(ops, { ordered: false });
  }
  await DocumentChunk.deleteMany({ ...base, chunkIndex: { $gte: chunks.length } });
}

/** Chunks of OTHER versions / pipelines of this document are obsolete once the current one is indexed. */
async function dropObsoleteChunks(job) {
  await DocumentChunk.deleteMany({
    organization: job.organization,
    document: job.document,
    $or: [{ version: { $ne: job.version } }, { pipelineVersion: { $ne: job.pipelineVersion } }],
  });
}

async function submitResult({ jobId, lockToken, result: raw }) {
  const job = await loadOwnedJob(jobId, lockToken);

  // Idempotent replay of a result we already accepted (the worker retried after a lost response).
  if ([S.INDEXED, S.SKIPPED].includes(job.status) && job.lockedBy === null && job.finishedAt) {
    const replay = resultSchema.safeParse(raw);
    if (replay.success && replay.data.status === job.status) return { ok: true, status: job.status, duplicate: true };
    throw lockLost();
  }
  if (job.status !== S.PROCESSING || job.lockExpiresAt <= new Date()) throw lockLost();

  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) {
    // A malformed result is a worker bug: count it as an internal failure so it retries, then dies.
    await jobs.failJob({ job, reason: FAIL_REASONS.INTERNAL_ERROR });
    throw new AppError('Invalid result', 400, 'INVALID_RESULT');
  }
  const result = parsed.data;

  if (result.status === 'failed') {
    await jobs.failJob({ job, reason: result.reason });
    return { ok: true, status: 'failed' };
  }

  // The document may have changed / been trashed while the worker was busy. Decide against the LIVE document.
  const stale = await jobs.staleReason(job);
  if (stale) {
    await jobs.skipJob({ job, reason: stale });
    throw gone(stale);
  }

  if (result.status === 'skipped') {
    const updated = await jobs.skipJob({ job, reason: result.reason });
    if (!updated) throw lockLost();
    return { ok: true, status: 'skipped' };
  }

  try {
    validateChunks(job, result);
  } catch (error) {
    await jobs.failJob({ job, reason: FAIL_REASONS.INTERNAL_ERROR }); // a worker bug: retry, then dead - never stuck "processing"
    throw error;
  }
  await writeChunks(job, result.chunks);

  // Final, fenced transition. If the lease was lost meanwhile this matches nothing and the job is NOT indexed.
  const now = new Date();
  const done = await DocumentIngestionJob.findOneAndUpdate(
    { ...jobs.lockFilter(job._id, lockToken, now) },
    { $set: { status: S.INDEXED, reason: null, finishedAt: now, stats: { ...result.stats, chunkCount: result.chunks.length }, lockedBy: null, lockExpiresAt: null } },
    { returnDocument: 'after' },
  );
  if (!done) throw lockLost();

  // Re-check after the write: a new version may have landed while we were inserting. Then these chunks are stale.
  const after = await jobs.staleReason(job);
  if (after) {
    await DocumentIngestionJob.updateOne({ _id: job._id, status: S.INDEXED }, { $set: { status: S.SKIPPED, reason: after, stats: null, finishedAt: new Date() } });
    await DocumentChunk.deleteMany({ organization: job.organization, document: job.document, version: job.version, pipelineVersion: job.pipelineVersion });
    throw gone(after);
  }
  await dropObsoleteChunks(job);
  await require('../embedding').documentIndexed(job.organization, job.document, job.version); // best effort; embedding follows extraction
  return { ok: true, status: 'indexed', chunks: result.chunks.length };
}

module.exports = { claimJob, dropObsoleteChunks, heartbeat, openContent, resultSchema, submitResult, writeChunks };
