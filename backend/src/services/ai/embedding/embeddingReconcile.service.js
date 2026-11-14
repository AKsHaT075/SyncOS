const env = require('../../../config/env');
const { createRedisClient } = require('../../../config/redis');
const AiEmbeddingConfig = require('../../../models/AiEmbeddingConfig');
const AiOrgSettings = require('../../../models/AiOrgSettings');
const Document = require('../../../models/Document');
const DocumentIngestionJob = require('../../../models/DocumentIngestionJob');
const EmbeddingJob = require('../../../models/EmbeddingJob');
const { INGESTION_PIPELINE_VERSION: INGEST_PIPELINE, INGESTION_STATUS } = require('../../../constants/ingestion.constants');
const { EMBEDDING_KIND: KIND, EMBEDDING_STATUS: S, SKIP_REASONS } = require('../../../constants/embedding.constants');
const { isAiEnabled } = require('../ingestion/ingestionJobs.service');
const jobs = require('./embeddingJobs.service');
const spaces = require('./embeddingSpaces.service');

/**
 * Brings embedding jobs - and, through purge jobs, the vector index - back in line with the LIVE documents. It is the
 * safety net behind the lifecycle hooks (a crash between "document changed" and "job created" is repaired here), the
 * way existing documents get embedded when AI is switched on, and how a new embedding space gets filled. It never
 * reads document text, and it never talks to the vector database.
 */

const MAY_HAVE_VECTORS = [S.QUEUED, S.PROCESSING, S.COMPLETED, S.FAILED, S.DEAD];

/** Documents trashed or permanently deleted: their vectors must go (in EVERY space), and no embedding may be queued. */
async function onDocumentsRemoved(organization, documentIds) {
  if (!documentIds.length) return;
  const rows = await EmbeddingJob.find({ organization, document: { $in: documentIds }, kind: KIND.EMBED, status: { $in: MAY_HAVE_VECTORS } }).select('document spaceId').lean();
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.document}:${r.spaceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // eslint-disable-next-line no-await-in-loop
    await jobs.enqueuePurge({ organization, document: r.document, spaceId: r.spaceId, keepVersion: null, source: 'removed' });
  }
  await EmbeddingJob.updateMany(
    { organization, document: { $in: documentIds }, kind: KIND.EMBED, status: { $in: [S.QUEUED, S.FAILED, S.COMPLETED, S.DEAD] } },
    { $set: { status: S.SKIPPED, reason: SKIP_REASONS.DOCUMENT_DELETED, finishedAt: new Date() } },
  );
  // a job that is processing right now notices at its next heartbeat / chunk page / result (and purges what it wrote)
}

async function reconcileOrganization({ organization, after = null, limit = env.AI_INGEST_SWEEP_BATCH }) {
  const summary = { examined: 0, enqueued: 0, purged: 0, superseded: 0, cursor: null };
  if (!(await isAiEnabled(organization))) return { ...summary, skipped: 'AI_DISABLED' };
  const spaceIds = await spaces.activeSpaceIds();

  const filter = { organization };
  if (after) filter._id = { $gt: after };
  const docs = await Document.find(filter).sort({ _id: 1 }).limit(limit).select('currentVersion deletedAt').lean();
  if (docs.length === 0) return summary;
  summary.examined = docs.length;
  summary.cursor = docs.length === limit ? docs[docs.length - 1]._id : null;

  const ids = docs.map((d) => d._id);
  const [ingest, embeds] = await Promise.all([
    DocumentIngestionJob.find({ organization, document: { $in: ids }, pipelineVersion: INGEST_PIPELINE }).select('document version status').lean(),
    EmbeddingJob.find({ organization, document: { $in: ids }, kind: KIND.EMBED }).select('document version spaceId status reason').lean(),
  ]);
  const group = (rows) => rows.reduce((m, r) => (m.get(r.document.toString())?.push(r) ?? m.set(r.document.toString(), [r]), m), new Map());
  const ingestBy = group(ingest);
  const embedsBy = group(embeds);

  const removed = [];
  for (const doc of docs) {
    const mine = embedsBy.get(doc._id.toString()) || [];
    if (doc.deletedAt) {
      if (mine.some((r) => MAY_HAVE_VECTORS.includes(r.status))) removed.push(doc._id);
      continue;
    }
    const current = (ingestBy.get(doc._id.toString()) || []).find((j) => j.version === doc.currentVersion);
    if (current && current.status === INGESTION_STATUS.INDEXED) {
      for (const spaceId of spaceIds) {
        const has = mine.find((r) => r.version === doc.currentVersion && r.spaceId === spaceId);
        if (!has || (has.status === S.SKIPPED && [SKIP_REASONS.DOCUMENT_DELETED, SKIP_REASONS.INGESTION_NOT_INDEXED, SKIP_REASONS.NO_CHUNKS].includes(has.reason))) {
          // eslint-disable-next-line no-await-in-loop
          const r = await jobs.enqueueEmbed({ organization, document: doc._id, version: doc.currentVersion, spaceId, source: 'reconcile' });
          if (r.created || has) summary.enqueued += 1;
        }
      }
    }
    // Vectors of versions that are no longer current go, once the current version is settled one way or the other.
    const settled = current && [INGESTION_STATUS.INDEXED, INGESTION_STATUS.SKIPPED, INGESTION_STATUS.DEAD].includes(current.status);
    const currentDone = mine.some((r) => r.version === doc.currentVersion && r.status === S.COMPLETED);
    const obsolete = mine.filter((r) => r.version !== doc.currentVersion && MAY_HAVE_VECTORS.includes(r.status));
    if (obsolete.length && settled && (currentDone || current.status !== INGESTION_STATUS.INDEXED)) {
      for (const spaceId of new Set(obsolete.map((r) => r.spaceId))) {
        // eslint-disable-next-line no-await-in-loop
        await jobs.enqueuePurge({ organization, document: doc._id, spaceId, keepVersion: doc.currentVersion, source: 'reconcile' });
        summary.purged += 1;
      }
      // eslint-disable-next-line no-await-in-loop
      await EmbeddingJob.updateMany({ _id: { $in: obsolete.map((r) => r._id) }, status: { $in: [S.QUEUED, S.FAILED, S.COMPLETED, S.DEAD] } }, { $set: { status: S.SKIPPED, reason: SKIP_REASONS.SUPERSEDED, finishedAt: new Date() } });
      summary.superseded += obsolete.length;
    }
  }
  if (removed.length) {
    await onDocumentsRemoved(organization, removed);
    summary.purged += removed.length;
  }
  summary.purged += await reconcileOrphans(organization);
  return summary;
}

/** Embedding rows whose document no longer exists at all (a crash between deleting it and requesting the purge). */
async function reconcileOrphans(organization, limit = 500) {
  const rows = await EmbeddingJob.aggregate([
    { $match: { organization, kind: KIND.EMBED, status: { $in: MAY_HAVE_VECTORS } } },
    { $group: { _id: { document: '$document', spaceId: '$spaceId' } } },
    { $limit: limit },
    { $lookup: { from: Document.collection.name, localField: '_id.document', foreignField: '_id', as: 'd' } },
    { $match: { 'd.0': { $exists: false } } },
  ]);
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await jobs.enqueuePurge({ organization, document: r._id.document, spaceId: r._id.spaceId, keepVersion: null, source: 'orphan' });
  }
  return rows.length;
}

/**
 * Periodic re-verification: a few completed jobs whose last check is old go back to the queue. The worker's embed is a
 * "sync to desired state" (compares stored hashes, repairs gaps, deletes strays), so on a healthy index this is cheap
 * and on a damaged one (lost Qdrant data, partial writes) it repairs it.
 */
async function requeueVerification({ organization = null, force = false, limit = env.AI_EMBEDDING_VERIFY_BATCH } = {}) {
  const ids = await spaces.activeSpaceIds();
  const cutoff = new Date(Date.now() - env.AI_EMBEDDING_VERIFY_DAYS * 86400 * 1000);
  const filter = { kind: KIND.EMBED, status: S.COMPLETED, spaceId: { $in: ids } };
  if (!force) filter.lastVerifiedAt = { $lt: cutoff };
  if (organization) filter.organization = organization;
  const due = await EmbeddingJob.find(filter).sort({ lastVerifiedAt: 1 }).limit(limit).select('_id').lean();
  if (!due.length) return 0;
  const r = await EmbeddingJob.updateMany({ _id: { $in: due.map((d) => d._id) }, status: S.COMPLETED }, { $set: { status: S.QUEUED, nextRunAt: new Date(), attempts: 0, source: 'verify', finishedAt: null } });
  return r.modifiedCount;
}

/** After a promotion the previous space is kept for a grace period, then its vectors are purged. */
async function retireOldSpace() {
  const cfg = await spaces.getConfig();
  if (!cfg || !cfg.retiringSpaceId || !cfg.retireAfter || cfg.retireAfter > new Date()) return { retired: 0 };
  const space = cfg.retiringSpaceId;
  const rows = await EmbeddingJob.find({ spaceId: space, kind: KIND.EMBED, status: { $ne: S.SKIPPED } }).limit(500).select('organization document').lean();
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await jobs.enqueuePurge({ organization: r.organization, document: r.document, spaceId: space, keepVersion: null, source: 'retire' });
  }
  await EmbeddingJob.updateMany({ _id: { $in: (await EmbeddingJob.find({ spaceId: space, kind: KIND.EMBED, status: { $ne: S.SKIPPED } }).limit(500).select('_id').lean()).map((r) => r._id) } }, { $set: { status: S.SKIPPED, reason: SKIP_REASONS.SPACE_RETIRED, finishedAt: new Date() } });
  const remaining = await EmbeddingJob.countDocuments({ spaceId: space, $or: [{ kind: KIND.EMBED, status: { $ne: S.SKIPPED } }, { kind: KIND.PURGE, status: { $ne: S.COMPLETED } }] });
  if (remaining === 0) {
    await AiEmbeddingConfig.updateOne({ _id: 'embedding', retiringSpaceId: space }, { $set: { retiringSpaceId: null, retireAfter: null }, $inc: { revision: 1 }, $push: { history: { $each: [{ at: new Date(), action: 'retired', from: space, to: null }], $slice: -20 } } });
    await EmbeddingJob.deleteMany({ spaceId: space });
  }
  return { retired: rows.length, remaining };
}

const cursorKey = (organization) => `${env.AI_REDIS_PREFIX}:embed:cursor:${organization}`;

async function sweepAll({ maxPagesPerOrg = 3 } = {}) {
  await spaces.ensureConfig();
  const orgs = await AiOrgSettings.find({ enabled: true }).select('organization').lean();
  const redis = createRedisClient();
  const totals = { organizations: orgs.length, examined: 0, enqueued: 0, purged: 0, superseded: 0, verified: 0 };
  for (const { organization } of orgs) {
    let after = null;
    if (redis.isOpen) after = (await redis.get(cursorKey(organization)).catch(() => null)) || null;
    for (let page = 0; page < maxPagesPerOrg; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await reconcileOrganization({ organization, after });
      for (const k of ['examined', 'enqueued', 'purged', 'superseded']) totals[k] += r[k];
      after = r.cursor ? r.cursor.toString() : null;
      if (!after) break;
    }
    if (redis.isOpen) {
      // eslint-disable-next-line no-await-in-loop
      await (after ? redis.set(cursorKey(organization), after, { EX: 86400 }) : redis.del(cursorKey(organization))).catch(() => {});
    }
  }
  totals.verified = await requeueVerification();
  await retireOldSpace();
  return totals;
}

module.exports = { onDocumentsRemoved, reconcileOrganization, reconcileOrphans, requeueVerification, retireOldSpace, sweepAll };
