/**
 * Public surface of embeddings for the rest of the backend. Lifecycle hooks only: ingestion calls these, and every
 * call is best-effort - embedding can never fail an upload, a restore or a delete (reconciliation repairs gaps).
 */
const jobs = require('./embeddingJobs.service');
const reconcile = require('./embeddingReconcile.service');
const spaces = require('./embeddingSpaces.service');

async function safely(fn, ...args) {
  try {
    return await fn(...args);
  } catch (error) {
    console.error('[ai-embedding] hook failed:', error.name); // the name only: messages can carry identifiers
    return null;
  }
}

module.exports = {
  /** A document version finished extraction (chunks exist): embed it into every space being served or built. */
  documentIndexed: (organization, document, version) => safely(jobs.enqueueEmbedAllSpaces, { organization, document, version, source: 'ingestion' }),
  documentsTrashed: (organization, ids) => safely(reconcile.onDocumentsRemoved, organization, ids),
  documentsPurged: (organization, ids) => safely(reconcile.onDocumentsRemoved, organization, ids),
  jobs,
  reconcile,
  spaces,
};
