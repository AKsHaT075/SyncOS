const { AUDIT_EVENTS } = require('../../../constants/audit.constants');
const { EMBEDDING_PIPELINE, REASON_MESSAGES } = require('../../../constants/embedding.constants');
const { logAudit } = require('../../audit.service');
const { isWorkerAuthConfigured } = require('../ingestion/ingestionWorkerAuth');
const jobs = require('./embeddingJobs.service');
const reconcile = require('./embeddingReconcile.service');
const spaces = require('./embeddingSpaces.service');

/**
 * Embedding administration. Tenant admins (MANAGE_AI_KNOWLEDGE) see and act on THEIR organization's jobs only. The
 * embedding space configuration is PLATFORM-wide, so promote / abandon / start are super-admin operations on separate
 * routes - one tenant must not be able to switch the index for all the others. Responses carry ids, counts and
 * statuses - never document names, text or vectors.
 */

const present = (job) => ({ ...job.toSafeObject(), reasonMessage: job.reason ? REASON_MESSAGES[job.reason] || null : null });

const describe = (cfg, id) => {
  if (!id) return null;
  const d = cfg.spaces && cfg.spaces[id];
  return d ? { spaceId: id, model: d.model, revision: d.revision, dimensions: d.dimensions, queryPrefix: d.queryPrefix, passagePrefix: d.passagePrefix, ingestionPipeline: d.ingestionPipeline, embeddingPipeline: d.embeddingPipeline } : { spaceId: id };
};

/**
 * Tenant view: THIS organization's jobs and coverage, and the name of the model being served. Nothing platform-wide
 * (no other tenant's counts) and nothing that can change the platform-wide embedding space.
 */
async function getOverview({ actor }) {
  const cfg = await spaces.ensureConfig();
  const org = actor.organization;
  const [summary, activeCoverage, targetCoverage] = await Promise.all([jobs.summarize(org), cfg.activeSpaceId ? spaces.coverage(cfg.activeSpaceId, org) : null, cfg.targetSpaceId ? spaces.coverage(cfg.targetSpaceId, org) : null]);
  return {
    embeddingPipeline: EMBEDDING_PIPELINE,
    workerConfigured: isWorkerAuthConfigured(),
    activeSpace: describe(cfg, cfg.activeSpaceId),
    migrationInProgress: Boolean(cfg.targetSpaceId),
    activeCoverage,
    targetCoverage,
    ...summary,
  };
}

/** Platform view (super-admin only): the embedding space configuration, global coverage, and migration history. */
async function getPlatformOverview() {
  const cfg = await spaces.ensureConfig();
  const configured = spaces.configured();
  const [activeCoverage, targetCoverage] = await Promise.all([cfg.activeSpaceId ? spaces.coverage(cfg.activeSpaceId) : null, cfg.targetSpaceId ? spaces.coverage(cfg.targetSpaceId) : null]);
  const validation = cfg.targetSpaceId ? await spaces.validateTarget(cfg) : null;
  return {
    embeddingPipeline: EMBEDDING_PIPELINE,
    configuredSpace: describe(cfg, configured.id),
    activeSpace: describe(cfg, cfg.activeSpaceId),
    targetSpace: describe(cfg, cfg.targetSpaceId),
    retiringSpace: describe(cfg, cfg.retiringSpaceId),
    blockedSpaceId: cfg.blockedSpaceId || null,
    activeCoverage,
    targetCoverage,
    migrationReady: validation ? validation.ok : null,
    migrationProblems: validation ? validation.problems : [],
    promotedAt: cfg.promotedAt,
    history: (cfg.history || []).slice(-10),
  };
}

async function listJobs({ actor, query }) {
  const page = query.page || 1;
  const limit = query.limit || 25;
  const { items, total } = await jobs.listJobs({ organization: actor.organization, status: query.status, reason: query.reason, kind: query.kind, spaceId: query.spaceId, page, limit });
  return { items: items.map(present), page, limit, total };
}

const audit = (actor, req, action, metadata, entityId) => logAudit({ action, entityId: entityId || (actor.organization ? actor.organization.toString() : 'platform'), entityType: 'ai_embedding', metadata, organizationId: actor.organization || null, req, userId: actor._id });

async function retryJob({ actor, id, req }) {
  const job = await jobs.retryJob({ organization: actor.organization, jobId: id });
  await audit(actor, req, AUDIT_EVENTS.AI_EMBEDDING_RETRIED, { kind: job.kind, spaceId: job.spaceId }, job._id.toString());
  return { job: present(job) };
}

async function reconcileNow({ actor, req }) {
  const totals = { examined: 0, enqueued: 0, purged: 0, superseded: 0 };
  let after = null;
  let completed = false;
  let skipped = null;
  await spaces.ensureConfig();
  for (let page = 0; page < 25; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await reconcile.reconcileOrganization({ organization: actor.organization, after });
    if (r.skipped) {
      skipped = r.skipped;
      break;
    }
    for (const k of Object.keys(totals)) totals[k] += r[k];
    after = r.cursor;
    if (!after) {
      completed = true;
      break;
    }
  }
  await audit(actor, req, AUDIT_EVENTS.AI_EMBEDDING_RECONCILED, totals);
  return { ...totals, completed, skipped };
}

/** Re-checks this organization's embedded documents against the index (the worker repairs any drift it finds). */
async function verifyNow({ actor, req }) {
  const requeued = await reconcile.requeueVerification({ organization: actor.organization, force: true, limit: 1000 });
  await audit(actor, req, AUDIT_EVENTS.AI_EMBEDDING_VERIFY_REQUESTED, { requeued });
  return { requeued };
}

async function promote({ actor, req }) {
  const { config, coverage } = await spaces.promote();
  await audit(actor, req, AUDIT_EVENTS.AI_EMBEDDING_SPACE_PROMOTED, { to: config.activeSpaceId, retiring: config.retiringSpaceId, coverage });
  return { activeSpace: describe(config, config.activeSpaceId), retiringSpace: describe(config, config.retiringSpaceId), coverage };
}

async function abandon({ actor, req }) {
  const { config, abandoned } = await spaces.abandonMigration();
  await audit(actor, req, AUDIT_EVENTS.AI_EMBEDDING_MIGRATION_ABANDONED, { abandoned });
  return { activeSpace: describe(config, config.activeSpaceId), abandoned };
}

async function start({ actor, req }) {
  const cfg = await spaces.unblockAndStart();
  await audit(actor, req, AUDIT_EVENTS.AI_EMBEDDING_MIGRATION_STARTED, { target: cfg.targetSpaceId });
  return { targetSpace: describe(cfg, cfg.targetSpaceId) };
}

module.exports = { abandon, getOverview, getPlatformOverview, listJobs, promote, reconcileNow, retryJob, start, verifyNow };
