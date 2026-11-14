/**
 * Public surface of document ingestion for the rest of the backend. Document code calls ONLY these, and every
 * call is best-effort: ingestion must never make an upload, restore or delete fail (reconciliation repairs gaps).
 */
const jobs = require('./ingestionJobs.service');
const reconcile = require('./ingestionReconcile.service');
const embedding = require('../embedding');

async function safely(fn, ...args) {
  try {
    return await fn(...args);
  } catch (error) {
    console.error('[ai-ingest] hook failed:', error.name); // name only: messages can contain document identifiers
    return null;
  }
}

module.exports = {
  /** A document's current version should be (re)indexed: upload, new version, restored version, restored from trash. */
  documentChanged: (documentId, organization, source) => jobs.enqueueCurrentVersion(documentId, organization, source),
  /** Documents moved to the trash. */
  documentsTrashed: async (organization, ids) => {
    await safely(reconcile.onDocumentsRemoved, organization, ids);
    await embedding.documentsTrashed(organization, ids); // vectors go too
  },
  /** Documents permanently deleted. */
  documentsPurged: async (organization, ids) => {
    await safely(reconcile.purgeDocumentIngestion, organization, ids);
    await embedding.documentsPurged(organization, ids);
  },
  jobs,
  reconcile,
};
