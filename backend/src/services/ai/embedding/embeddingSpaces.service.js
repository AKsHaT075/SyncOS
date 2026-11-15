const crypto = require('crypto');
const env = require('../../../config/env');
const AppError = require('../../../utils/app-error');
const AiEmbeddingConfig = require('../../../models/AiEmbeddingConfig');
const AiOrgSettings = require('../../../models/AiOrgSettings');
const Document = require('../../../models/Document');
const DocumentChunk = require('../../../models/DocumentChunk');
const DocumentIngestionJob = require('../../../models/DocumentIngestionJob');
const EmbeddingJob = require('../../../models/EmbeddingJob');
const { INGESTION_PIPELINE_VERSION: INGEST_PIPELINE, INGESTION_STATUS } = require('../../../constants/ingestion.constants');
const { EMBEDDING_KIND: KIND, EMBEDDING_STATUS: S, describeSpace } = require('../../../constants/embedding.constants');

/**
 * Which embedding space is SERVED (active) and which is being BUILT (target). Retrieval may only use the
 * active space. A model/pipeline change never touches the active space: workers fill the target in the background and
 * `promote()` flips the pointer in ONE compare-and-swap, only when the target is complete and verified. A migration
 * that fails, stalls or is abandoned therefore leaves the previous space exactly as usable as it was.
 *
 * (An embedding space is identified by a hash of model + revision + dimensions + prefixes + pooling + normalization +
 * embedding pipeline + ingestion pipeline: see constants/embedding.constants.js.)
 */

const ID = 'embedding';

function configured() {
  const space = describeSpace(env.AI_EMBEDDING_SPACE);
  if (!space) throw new AppError('AI_EMBEDDING_SPACE names an unknown embedding space', 500, 'EMBEDDING_CONFIG');
  return space;
}

const history = (action, from, to) => ({ at: new Date(), action, from: from || null, to: to || null });

/**
 * Brings the singleton in line with the configured space. First run: target = configured (nothing active yet).
 * Configured != active: a migration starts (target = configured) - unless an administrator blocked that space.
 * Idempotent and safe under concurrent callers (compare-and-swap on `revision`).
 */
async function ensureConfig() {
  const space = configured();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    let cfg = await AiEmbeddingConfig.findById(ID);
    if (!cfg) {
      try {
        // eslint-disable-next-line no-await-in-loop
        cfg = await AiEmbeddingConfig.create({ _id: ID, targetSpaceId: space.id, spaces: { [space.id]: space.descriptor }, history: [history('first_run', null, space.id)] });
        return cfg;
      } catch (error) {
        if (error.code === 11000) continue;
        throw error;
      }
    }
    const known = cfg.spaces && cfg.spaces[space.id];
    const wants = {};
    if (!known) wants[`spaces.${space.id}`] = space.descriptor;
    if (cfg.activeSpaceId === space.id) {
      if (cfg.targetSpaceId) wants.targetSpaceId = null;
    } else if (cfg.targetSpaceId !== space.id && cfg.blockedSpaceId !== space.id) {
      wants.targetSpaceId = space.id;
    }
    if (Object.keys(wants).length === 0) return cfg;
    // eslint-disable-next-line no-await-in-loop
    const updated = await AiEmbeddingConfig.findOneAndUpdate(
      { _id: ID, revision: cfg.revision },
      { $set: wants, $inc: { revision: 1 }, ...(wants.targetSpaceId ? { $push: { history: { $each: [history('migration_started', cfg.activeSpaceId, space.id)], $slice: -20 } } } : {}) },
      { returnDocument: 'after' },
    );
    if (updated) return updated;
  }
  return AiEmbeddingConfig.findById(ID);
}

async function getConfig() {
  return AiEmbeddingConfig.findById(ID);
}

async function activeSpaceIds() {
  const cfg = await ensureConfig();
  return [cfg.activeSpaceId, cfg.targetSpaceId].filter(Boolean);
}

async function isServedSpace(spaceId) {
  return (await activeSpaceIds()).includes(spaceId);
}

/** The descriptor a result must match. Unknown ids are refused. */
async function descriptorOf(spaceId) {
  const cfg = await getConfig();
  return (cfg && cfg.spaces && cfg.spaces[spaceId]) || null;
}

// ---------------------------------------------------------------------------------------------------------------
// Coverage and validation

/**
 * Documents that SHOULD have vectors: live, in an AI-enabled org, with the current version extracted (p2).
 * `organization` scopes the numbers to one tenant (tenant admins); without it they are platform-wide (super-admin only).
 */
async function coverage(spaceId, organization = null) {
  const enabled = await AiOrgSettings.find({ enabled: true, ...(organization ? { organization } : {}) }).select('organization').lean();
  const orgIds = enabled.map((o) => o.organization);
  const docColl = Document.collection.name;
  const jobColl = EmbeddingJob.collection.name;
  const rows = await DocumentIngestionJob.aggregate([
    { $match: { status: INGESTION_STATUS.INDEXED, pipelineVersion: INGEST_PIPELINE, organization: { $in: orgIds } } },
    {
      $lookup: {
        from: docColl,
        let: { d: '$document', o: '$organization', v: '$version' },
        pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$_id', '$$d'] }, { $eq: ['$organization', '$$o'] }, { $eq: ['$currentVersion', '$$v'] }, { $lte: ['$deletedAt', null] }] } } }, { $project: { _id: 1 } }],
        as: 'doc',
      },
    },
    { $match: { 'doc.0': { $exists: true } } },
    {
      $lookup: {
        from: jobColl,
        let: { d: '$document', o: '$organization', v: '$version' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$document', '$$d'] }, { $eq: ['$organization', '$$o'] }, { $eq: ['$version', '$$v'] }, { $eq: ['$kind', KIND.EMBED] }, { $eq: ['$spaceId', spaceId] }, { $eq: ['$ingestionPipeline', INGEST_PIPELINE] }, { $eq: ['$status', S.COMPLETED] }] } } },
          { $project: { _id: 1 } },
        ],
        as: 'emb',
      },
    },
    { $group: { _id: null, eligible: { $sum: 1 }, embedded: { $sum: { $cond: [{ $gt: [{ $size: '$emb' }, 0] }, 1, 0] } } } },
  ]);
  const base = rows[0] || { eligible: 0, embedded: 0 };
  const pending = await EmbeddingJob.aggregate([{ $match: { spaceId, kind: KIND.EMBED, ...(organization ? { organization } : {}) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const by = Object.fromEntries(pending.map((r) => [r._id, r.n]));
  return { eligible: base.eligible, embedded: base.embedded, queued: by.queued || 0, processing: by.processing || 0, failed: by.failed || 0, dead: by.dead || 0 };
}

const digestOf = (hashes) => crypto.createHash('sha256').update(hashes.join('\n')).digest('hex');

/** Re-derives a completed job's digest from the chunks Node holds RIGHT NOW. */
async function digestMatches(job) {
  const chunks = await DocumentChunk.find({ organization: job.organization, document: job.document, version: job.version, pipelineVersion: job.ingestionPipeline }).sort({ chunkIndex: 1 }).select('textHash').lean();
  return chunks.length === job.chunkCount && digestOf(chunks.map((c) => c.textHash)) === job.digest;
}

/**
 * Everything that must be true before the active pointer may move. Returns { ok, problems, coverage }.
 * Never mutates.
 */
async function validateTarget(cfg, { sample = 50 } = {}) {
  const problems = [];
  if (!cfg.targetSpaceId) return { ok: false, problems: ['NO_MIGRATION'], coverage: null };
  const descriptor = cfg.spaces && cfg.spaces[cfg.targetSpaceId];
  if (!descriptor) problems.push('UNKNOWN_SPACE');
  const cov = await coverage(cfg.targetSpaceId);
  if (cov.embedded !== cov.eligible) problems.push('INCOMPLETE_COVERAGE');
  if (cov.dead > 0) problems.push('DEAD_JOBS');
  if (cov.failed > 0) problems.push('FAILED_JOBS');
  if (cov.queued + cov.processing > 0) problems.push('JOBS_PENDING');
  // spot-check that what was embedded still corresponds to the chunks Node holds (and has the right shape)
  const done = await EmbeddingJob.find({ spaceId: cfg.targetSpaceId, kind: KIND.EMBED, status: S.COMPLETED }).sort({ lastVerifiedAt: 1 }).limit(sample).lean();
  for (const job of done) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await digestMatches(job))) {
      problems.push('DIGEST_MISMATCH');
      break;
    }
  }
  return { ok: problems.length === 0, problems, coverage: cov };
}

/**
 * Atomically makes the (validated) target the active space. The old active space is retained for a grace period.
 * If anything changed concurrently, the compare-and-swap fails and NOTHING moves.
 */
async function promote() {
  const cfg = await ensureConfig();
  const check = await validateTarget(cfg);
  if (!check.ok) throw new AppError('The new embedding space is not ready to be activated', 409, 'EMBEDDING_MIGRATION_NOT_READY', { problems: check.problems, coverage: check.coverage });
  const now = new Date();
  const promoted = await AiEmbeddingConfig.findOneAndUpdate(
    { _id: ID, revision: cfg.revision, targetSpaceId: cfg.targetSpaceId },
    {
      $set: {
        activeSpaceId: cfg.targetSpaceId,
        targetSpaceId: null,
        retiringSpaceId: cfg.activeSpaceId || null,
        retireAfter: cfg.activeSpaceId ? new Date(now.getTime() + env.AI_EMBEDDING_RETIRE_GRACE_HOURS * 3600 * 1000) : null,
        promotedAt: now,
      },
      $inc: { revision: 1 },
      $push: { history: { $each: [history('promoted', cfg.activeSpaceId, cfg.targetSpaceId)], $slice: -20 } },
    },
    { returnDocument: 'after' },
  );
  if (!promoted) throw new AppError('The embedding configuration changed while promoting; nothing was switched', 409, 'EMBEDDING_CONFIG_CHANGED');
  return { config: promoted, coverage: check.coverage };
}

/** Stops building the target and blocks it from being restarted until an administrator starts it again. */
async function abandonMigration() {
  const cfg = await ensureConfig();
  if (!cfg.targetSpaceId) throw new AppError('No migration is in progress', 409, 'EMBEDDING_NO_MIGRATION');
  const updated = await AiEmbeddingConfig.findOneAndUpdate(
    { _id: ID, revision: cfg.revision, targetSpaceId: cfg.targetSpaceId },
    { $set: { targetSpaceId: null, blockedSpaceId: cfg.targetSpaceId }, $inc: { revision: 1 }, $push: { history: { $each: [history('abandoned', cfg.activeSpaceId, cfg.targetSpaceId)], $slice: -20 } } },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('The embedding configuration changed; nothing was abandoned', 409, 'EMBEDDING_CONFIG_CHANGED');
  return { config: updated, abandoned: cfg.targetSpaceId };
}

async function unblockAndStart() {
  await AiEmbeddingConfig.updateOne({ _id: ID }, { $set: { blockedSpaceId: null }, $inc: { revision: 1 } });
  return ensureConfig();
}

module.exports = {
  abandonMigration,
  activeSpaceIds,
  configured,
  coverage,
  descriptorOf,
  digestMatches,
  digestOf,
  ensureConfig,
  getConfig,
  isServedSpace,
  promote,
  unblockAndStart,
  validateTarget,
};
