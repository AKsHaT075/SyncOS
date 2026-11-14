const env = require('../../../config/env');
const { createRedisClient } = require('../../../config/redis');
const AiOrgSettings = require('../../../models/AiOrgSettings');
const Document = require('../../../models/Document');
const DocumentChunk = require('../../../models/DocumentChunk');
const DocumentIngestionJob = require('../../../models/DocumentIngestionJob');
const { INGESTION_PIPELINE_VERSION: PIPELINE, INGESTION_STATUS: S, SKIP_REASONS } = require('../../../constants/ingestion.constants');
const jobs = require('./ingestionJobs.service');
const { dropObsoleteChunks } = require('./ingestionWorkerApi.service');

/**
 * Brings job + chunk state back in line with the LIVE documents. It is the safety net behind the upload hooks
 * (a crash between "document saved" and "job created" is repaired here) and the way existing documents get
 * indexed when AI is switched on later. It never reads or writes document text.
 */

/** Trashed / purged documents: no queued work, no chunks. (A processing job notices at its next heartbeat/submit.) */
async function onDocumentsRemoved(organization, documentIds) {
  if (!documentIds.length) return;
  await DocumentIngestionJob.updateMany(
    { organization, document: { $in: documentIds }, status: { $in: [S.QUEUED, S.FAILED] } },
    { $set: { status: S.SKIPPED, reason: SKIP_REASONS.DOCUMENT_DELETED, finishedAt: new Date(), stats: null } },
  );
  await DocumentChunk.deleteMany({ organization, document: { $in: documentIds } });
}

/** Permanent deletion: nothing about the document may remain. */
async function purgeDocumentIngestion(organization, documentIds) {
  if (!documentIds.length) return;
  await DocumentChunk.deleteMany({ organization, document: { $in: documentIds } });
  await DocumentIngestionJob.deleteMany({ organization, document: { $in: documentIds } });
}

/**
 * One page of documents for one organization. Returns { examined, enqueued, requeued, superseded, removed, cursor }
 * where cursor is the last document id seen (null when the end was reached).
 */
async function reconcileOrganization({ organization, after = null, limit = env.AI_INGEST_SWEEP_BATCH }) {
  const summary = { examined: 0, enqueued: 0, requeued: 0, superseded: 0, removed: 0, cursor: null };
  if (!(await jobs.isAiEnabled(organization))) return { ...summary, skipped: 'AI_DISABLED' };

  const filter = { organization };
  if (after) filter._id = { $gt: after };
  const docs = await Document.find(filter).sort({ _id: 1 }).limit(limit).select('extension size checksum currentVersion deletedAt').lean();
  if (docs.length === 0) return summary;
  summary.examined = docs.length;
  summary.cursor = docs.length === limit ? docs[docs.length - 1]._id : null;

  const ids = docs.map((d) => d._id);
  const existing = await DocumentIngestionJob.find({ organization, document: { $in: ids }, pipelineVersion: PIPELINE }).select('document version checksum status reason').lean();
  const byDoc = new Map();
  for (const job of existing) {
    const key = job.document.toString();
    if (!byDoc.has(key)) byDoc.set(key, []);
    byDoc.get(key).push(job);
  }

  const removedIds = [];
  for (const doc of docs) {
    const mine = byDoc.get(doc._id.toString()) || [];
    if (doc.deletedAt) {
      if (mine.some((j) => [S.QUEUED, S.FAILED].includes(j.status)) || mine.some((j) => j.status === S.INDEXED)) removedIds.push(doc._id);
      continue;
    }
    // Obsolete versions that never ran must not run now.
    const old = mine.filter((j) => j.version !== doc.currentVersion && [S.QUEUED, S.FAILED].includes(j.status));
    if (old.length) {
      // eslint-disable-next-line no-await-in-loop
      await DocumentIngestionJob.updateMany(
        { _id: { $in: old.map((j) => j._id) }, status: { $in: [S.QUEUED, S.FAILED] } },
        { $set: { status: S.SKIPPED, reason: SKIP_REASONS.SUPERSEDED, finishedAt: new Date(), stats: null } },
      );
      summary.superseded += old.length;
    }
    const current = mine.find((j) => j.version === doc.currentVersion);
    if (!current) {
      // eslint-disable-next-line no-await-in-loop
      const r = await jobs.enqueue({ organization, document: doc._id, version: doc.currentVersion, extension: doc.extension, size: doc.size, checksum: doc.checksum, source: 'reconcile' });
      if (r.created) summary.enqueued += 1;
    } else if (current.status === S.SKIPPED && current.reason === SKIP_REASONS.DOCUMENT_DELETED) {
      // Restored (e.g. together with its folder) after having been trashed: put the same version back to work.
      // eslint-disable-next-line no-await-in-loop
      const revived = await jobs.reviveDeleted({ organization, document: doc._id, version: doc.currentVersion, pipelineVersion: PIPELINE }, jobs.initialState({ extension: doc.extension, size: doc.size }));
      if (revived) summary.requeued += 1;
    } else if (current.checksum !== doc.checksum) {
      // Same version number, different bytes recorded: the old result cannot be trusted. Start over.
      const state = jobs.initialState({ extension: doc.extension, size: doc.size });
      const now = new Date();
      // eslint-disable-next-line no-await-in-loop
      await DocumentIngestionJob.updateOne(
        { _id: current._id },
        { $set: { status: state.status, reason: state.reason, format: state.format, size: doc.size, checksum: doc.checksum, attempts: 0, nextRunAt: now, finishedAt: state.status === S.SKIPPED ? now : null, stats: null, lockedBy: null, lockExpiresAt: null, source: 'reconcile' } },
      );
      // eslint-disable-next-line no-await-in-loop
      await DocumentChunk.deleteMany({ organization, document: doc._id, version: doc.currentVersion });
      summary.requeued += 1;
    } else if (current.status === S.INDEXED) {
      // eslint-disable-next-line no-await-in-loop
      await dropObsoleteChunks({ organization, document: doc._id, version: doc.currentVersion, pipelineVersion: PIPELINE });
    }
  }
  if (removedIds.length) {
    await onDocumentsRemoved(organization, removedIds);
    summary.removed = removedIds.length;
  }
  return summary;
}

const cursorKey = (organization) => `${env.AI_REDIS_PREFIX}:ingest:cursor:${organization}`;

/** Periodic sweep: a few pages per AI-enabled organization per call, remembering where it stopped. */
async function sweepAll({ maxPagesPerOrg = 3 } = {}) {
  const orgs = await AiOrgSettings.find({ enabled: true }).select('organization').lean();
  const redis = createRedisClient();
  const totals = { organizations: orgs.length, examined: 0, enqueued: 0, requeued: 0, superseded: 0, removed: 0 };
  for (const { organization } of orgs) {
    let after = null;
    if (redis.isOpen) after = (await redis.get(cursorKey(organization)).catch(() => null)) || null;
    for (let page = 0; page < maxPagesPerOrg; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await reconcileOrganization({ organization, after });
      for (const k of ['examined', 'enqueued', 'requeued', 'superseded', 'removed']) totals[k] += r[k];
      after = r.cursor ? r.cursor.toString() : null;
      if (!after) break;
    }
    if (redis.isOpen) {
      // eslint-disable-next-line no-await-in-loop
      await (after ? redis.set(cursorKey(organization), after, { EX: 86400 }) : redis.del(cursorKey(organization))).catch(() => {});
    }
  }
  return totals;
}

module.exports = { onDocumentsRemoved, purgeDocumentIngestion, reconcileOrganization, sweepAll };
