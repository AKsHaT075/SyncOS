const mongoose = require('mongoose');
const env = require('../../../config/env');
const { createRedisClient } = require('../../../config/redis');
const Document = require('../../../models/Document');
const DocumentChunk = require('../../../models/DocumentChunk');
const DocumentIngestionJob = require('../../../models/DocumentIngestionJob');
const EmbeddingJob = require('../../../models/EmbeddingJob');
const { DOCUMENT_VISIBILITY } = require('../../../constants/document.constants');
const { EMBEDDING_KIND, EMBEDDING_STATUS } = require('../../../constants/embedding.constants');
const { INGESTION_PIPELINE_VERSION: PIPELINE, INGESTION_STATUS } = require('../../../constants/ingestion.constants');
const { isSameId, resolveDocumentAccess } = require('../../../utils/documentAccess');
const { loadAccessContext } = require('../../documentAccess.service');
const spaces = require('../embedding/embeddingSpaces.service');

/**
 * THE authority on which retrieved chunks may be used to answer THIS user's question.
 *
 * Python searches the vector index and sends candidate identifiers here. Nothing in the index is trusted: the payload
 * (organization, document, version, ...) only told Python where to look. For every candidate Node checks, against the
 * LIVE database and the user as they are RIGHT NOW:
 *   - the document exists in the user's organization and is not trashed or deleted
 *   - the candidate's version is the document's CURRENT version (stale versions are rejected)
 *   - extraction produced these chunks (ingestion `indexed`) and embedding finished in the ACTIVE space
 *   - the chunk exists and its text hash equals the one the vector was made from (a vector of since-changed text is stale)
 *   - the user may view the document (the ordinary document access rules: team/project membership is evaluated live)
 *   - AI-specific rule: a PRIVATE document is available to its OWNER only. Not to admins, and not to people it was shared with:
 *     the AI disclosure promises "private documents are included only for their owner".
 * Only then is the chunk text released. A candidate that fails any check is dropped silently, with no reason, so the
 * response cannot be used to probe what exists.
 */

const MAX_TOTAL_CHARS = 150_000;
const idOf = (v) => (v ? v.toString() : null);

/**
 * The documents among `docIds` that this user may use for AI RIGHT NOW (live): in their organization, not trashed, viewable under the
 * ordinary document rules, and - the AI-specific rule - a PRIVATE document only for its owner. Shared by retrieval and by the
 * re-check of citations stored in conversation history.
 */
async function usableDocuments(actor, docIds, ctx = null) {
  const docs = await Document.find({ _id: { $in: docIds }, organization: actor.organization, deletedAt: null }).select('name organization owner visibility team project sharedWith currentVersion').lean();
  const access = ctx || (await loadAccessContext(actor));
  const usable = new Map();
  for (const doc of docs) {
    const privateAndNotOwner = doc.visibility === DOCUMENT_VISIBILITY.PRIVATE && !isSameId(actor._id, doc.owner);
    if (resolveDocumentAccess(access, doc).canView && !privateAndNotOwner) usable.set(idOf(doc._id), doc);
  }
  return usable;
}

/** Which of the user's candidate chunks may be used, with their text. Never throws for an unauthorized candidate. */
async function authorizeChunks({ actor, candidates, requestKey = null }) {
  const unique = new Map();
  for (const c of candidates) {
    if (mongoose.isValidObjectId(c.documentId) && Number.isInteger(c.version) && Number.isInteger(c.chunkIndex) && typeof c.textHash === 'string') {
      unique.set(`${c.documentId}:${c.version}:${c.chunkIndex}`, c);
    }
  }
  const asked = [...unique.values()];
  const none = { items: [], rejected: candidates.length };
  if (asked.length === 0) return none;

  const cfg = await spaces.getConfig();
  const activeSpaceId = cfg && cfg.activeSpaceId;
  if (!activeSpaceId) return none; // nothing is served for retrieval yet

  const organization = actor.organization;
  const docIds = [...new Set(asked.map((c) => c.documentId))];

  const ctx = await loadAccessContext(actor);
  const usable = await usableDocuments(actor, docIds, ctx);

  const current = asked.filter((c) => usable.has(c.documentId) && usable.get(c.documentId).currentVersion === c.version);
  if (current.length === 0) return none;
  const liveIds = [...new Set(current.map((c) => c.documentId))];

  const [extracted, embedded] = await Promise.all([
    DocumentIngestionJob.find({ organization, document: { $in: liveIds }, pipelineVersion: PIPELINE, status: INGESTION_STATUS.INDEXED }).select('document version').lean(),
    EmbeddingJob.find({ organization, document: { $in: liveIds }, kind: EMBEDDING_KIND.EMBED, spaceId: activeSpaceId, ingestionPipeline: PIPELINE, status: EMBEDDING_STATUS.COMPLETED }).select('document version').lean(),
  ]);
  const ready = new Set(extracted.map((j) => `${j.document}:${j.version}`));
  const vectored = new Set(embedded.map((j) => `${j.document}:${j.version}`));
  const eligible = current.filter((c) => ready.has(`${c.documentId}:${c.version}`) && vectored.has(`${c.documentId}:${c.version}`));
  if (eligible.length === 0) return none;

  const chunks = await DocumentChunk.find({
    organization,
    pipelineVersion: PIPELINE,
    $or: eligible.map((c) => ({ document: c.documentId, version: c.version, chunkIndex: c.chunkIndex })),
  })
    .select('document version chunkIndex textHash text tokenEstimate location')
    .lean();
  const byKey = new Map(chunks.map((ch) => [`${ch.document}:${ch.version}:${ch.chunkIndex}`, ch]));

  const items = [];
  let total = 0;
  for (const c of eligible) {
    const chunk = byKey.get(`${c.documentId}:${c.version}:${c.chunkIndex}`);
    if (!chunk || chunk.textHash !== c.textHash) continue; // the text changed since this vector was made
    total += chunk.text.length;
    if (total > MAX_TOTAL_CHARS) break;
    const { _id: _ignored, ...location } = chunk.location || {};
    items.push({
      documentId: c.documentId,
      version: c.version,
      chunkIndex: c.chunkIndex,
      chunkId: idOf(chunk._id),
      textHash: chunk.textHash,
      text: chunk.text,
      tokens: chunk.tokenEstimate,
      documentName: usable.get(c.documentId).name,
      location: JSON.parse(JSON.stringify(location)),
    });
  }
  if (requestKey && items.length) await rememberAuthorized(requestKey, items.map((i) => i.chunkId));
  return { items, rejected: candidates.length - items.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Citations are re-checked at the exit: only chunks Node itself authorized for THIS request may be cited.

const authorizedKey = (requestKey) => `${env.AI_REDIS_PREFIX}:rag:auth:${requestKey}`;

async function rememberAuthorized(requestKey, chunkIds) {
  const client = createRedisClient();
  if (!client.isOpen) return; // without Redis nothing is remembered, so no citation can be confirmed (fail closed)
  try {
    await client.sAdd(authorizedKey(requestKey), chunkIds);
    await client.expire(authorizedKey(requestKey), env.AI_RAG_AUTHORIZED_TTL_SECONDS);
  } catch {
    /* fail closed: unconfirmed citations are dropped */
  }
}

/** Keeps only citations whose chunk this request authorized. Returns { citations, dropped }. */
async function confirmCitations(requestKey, citations) {
  if (!citations.length) return { citations: [], dropped: 0 };
  const client = createRedisClient();
  let known = new Set();
  if (client.isOpen) {
    try {
      known = new Set(await client.sMembers(authorizedKey(requestKey)));
    } catch {
      known = new Set();
    }
  }
  const kept = citations.filter((c) => known.has(c.chunkId));
  return { citations: kept, dropped: citations.length - kept.length };
}

async function forgetAuthorized(requestKey) {
  const client = createRedisClient();
  if (client.isOpen) await client.del(authorizedKey(requestKey)).catch(() => {});
}

module.exports = { usableDocuments, authorizeChunks, confirmCitations, forgetAuthorized };
