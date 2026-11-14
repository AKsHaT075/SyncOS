const { AUDIT_EVENTS } = require('../../../constants/audit.constants');
const { INGESTION_PIPELINE_VERSION: PIPELINE, REASON_MESSAGES } = require('../../../constants/ingestion.constants');
const { logAudit } = require('../../audit.service');
const jobs = require('./ingestionJobs.service');
const reconcile = require('./ingestionReconcile.service');
const { isWorkerAuthConfigured } = require('./ingestionWorkerAuth');

/**
 * Administrator view of ingestion for ONE organization (MANAGE_AI_KNOWLEDGE, enforced by the route).
 *
 * Deliberately returns document IDS, never names, titles or text: org admins have no automatic access to other
 * members' private documents, so a job list that named them would leak their existence and titles.
 */

const present = (job) => ({ ...job.toSafeObject(), reasonMessage: job.reason ? REASON_MESSAGES[job.reason] || null : null });

async function getOverview({ actor }) {
  const [summary, aiEnabled] = await Promise.all([jobs.summarize(actor.organization), jobs.isAiEnabled(actor.organization)]);
  return { aiEnabled, workerConfigured: isWorkerAuthConfigured(), pipelineVersion: PIPELINE, ...summary };
}

async function listJobs({ actor, query }) {
  const page = query.page || 1;
  const limit = query.limit || 25;
  const { items, total } = await jobs.listJobs({ organization: actor.organization, status: query.status, reason: query.reason, page, limit });
  return { items: items.map(present), page, limit, total };
}

async function retryJob({ actor, id, req }) {
  const job = await jobs.retryJob({ organization: actor.organization, jobId: id });
  await logAudit({
    action: AUDIT_EVENTS.AI_INGESTION_RETRIED,
    entityId: job._id.toString(),
    entityType: 'ai_ingestion_job',
    metadata: { documentId: job.document.toString(), version: job.version },
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });
  return { job: present(job) };
}

/** Runs the reconciliation for this organization now (bounded), e.g. after enabling AI to back-fill documents. */
async function reconcileNow({ actor, req }) {
  const totals = { examined: 0, enqueued: 0, requeued: 0, superseded: 0, removed: 0 };
  let after = null;
  let completed = false;
  let skipped = null;
  for (let page = 0; page < 25; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await reconcile.reconcileOrganization({ organization: actor.organization, after });
    if (r.skipped) {
      skipped = r.skipped;
      break;
    }
    for (const key of Object.keys(totals)) totals[key] += r[key];
    after = r.cursor;
    if (!after) {
      completed = true;
      break;
    }
  }
  await logAudit({
    action: AUDIT_EVENTS.AI_INGESTION_RECONCILED,
    entityId: actor.organization.toString(),
    entityType: 'ai_ingestion',
    metadata: totals,
    organizationId: actor.organization,
    req,
    userId: actor._id,
  });
  return { ...totals, completed, skipped };
}

module.exports = { getOverview, listJobs, reconcileNow, retryJob };
