const crypto = require('crypto');
const { INGESTION_PIPELINE_VERSION } = require('./ingestion.constants');

/**
 * Embeddings (Phase 4). Python embeds and writes vectors; Node owns every durable fact about them (jobs, which
 * embedding SPACE is active, coverage) and never talks to the vector database. Mirrored in ai/contracts/embedding.json,
 * which BOTH test suites read - including golden space ids, so Node and Python cannot disagree about what a space is.
 */

const EMBEDDING_PIPELINE = 'e1';

const EMBEDDING_STATUS = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed', // transient; retried when nextRunAt passes
  DEAD: 'dead', // retry budget exhausted; needs an administrator
  SKIPPED: 'skipped', // nothing to (or no longer allowed to) embed, with a reason
});

const EMBEDDING_KIND = Object.freeze({ EMBED: 'embed', PURGE: 'purge' });

/** Purge jobs are per (document, space) and cover every pipeline: this sentinel keeps the unique key well-formed. */
const ANY_PIPELINE = '*';

/**
 * An embedding SPACE is everything that decides what a vector means. Its id is a hash of the canonical descriptor, so
 * changing the model, revision, prefixes, dimensions, pooling, normalization, either pipeline version... yields a
 * different space (a different collection, different jobs) - vectors of different spaces are never mixed or compared.
 */
const MODELS = Object.freeze({
  'multilingual-e5-small': {
    provider: 'fastembed-onnx',
    model: 'intfloat/multilingual-e5-small',
    revision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
    modelFile: 'onnx/model.onnx',
    dimensions: 384,
    pooling: 'mean',
    normalize: true,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    maxTokens: 512,
    distance: 'cosine',
  },
  // Deterministic test double. Own model name => own space id => its vectors can never be mistaken for real ones.
  'fake-hash-384': {
    provider: 'fake',
    model: 'syncos/fake-hash',
    revision: 'test',
    modelFile: 'none',
    dimensions: 384,
    pooling: 'mean',
    normalize: true,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    maxTokens: 512,
    distance: 'cosine',
  },
});

const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])])) : value);

/** Same canonical form as ai/app/embeddings/spec.py: sorted keys, compact separators, UTF-8. */
const canonicalJson = (descriptor) => JSON.stringify(sortKeys(descriptor));
const spaceIdOf = (descriptor) => crypto.createHash('sha256').update(canonicalJson(descriptor), 'utf8').digest('hex').slice(0, 12);

function describeSpace(key, ingestionPipeline = INGESTION_PIPELINE_VERSION) {
  const model = MODELS[key];
  if (!model) return null;
  const descriptor = { ...model, embeddingPipeline: EMBEDDING_PIPELINE, ingestionPipeline };
  return { key, descriptor, id: spaceIdOf(descriptor) };
}

const FAIL_REASONS = Object.freeze({
  VECTOR_STORE_UNAVAILABLE: 'VECTOR_STORE_UNAVAILABLE',
  VECTOR_STORE_AUTH: 'VECTOR_STORE_AUTH',
  VECTOR_DIMENSION_MISMATCH: 'VECTOR_DIMENSION_MISMATCH',
  VECTOR_INVALID: 'VECTOR_INVALID',
  VECTOR_COUNT_MISMATCH: 'VECTOR_COUNT_MISMATCH',
  EMBEDDING_UNAVAILABLE: 'EMBEDDING_UNAVAILABLE',
  EMBEDDING_INPUT_TOO_LONG: 'EMBEDDING_INPUT_TOO_LONG',
  EMBEDDING_BAD_OUTPUT: 'EMBEDDING_BAD_OUTPUT',
  NODE_UNAVAILABLE: 'NODE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  LOCK_EXPIRED: 'LOCK_EXPIRED', // Node-decided: the worker stopped heartbeating
  RESULT_MISMATCH: 'RESULT_MISMATCH', // Node-decided: the worker's report disagrees with what Node knows
});
const WORKER_FAIL_REASONS = Object.freeze(Object.values(FAIL_REASONS).filter((r) => !['LOCK_EXPIRED', 'RESULT_MISMATCH'].includes(r)));

const SKIP_REASONS = Object.freeze({
  SUPERSEDED: 'SUPERSEDED',
  DOCUMENT_DELETED: 'DOCUMENT_DELETED',
  NO_CHUNKS: 'NO_CHUNKS',
  INGESTION_NOT_INDEXED: 'INGESTION_NOT_INDEXED',
  SPACE_RETIRED: 'SPACE_RETIRED',
});

const REASON_MESSAGES = Object.freeze({
  VECTOR_STORE_UNAVAILABLE: 'The vector database could not be reached.',
  VECTOR_STORE_AUTH: 'The vector database rejected the worker\'s credentials.',
  VECTOR_DIMENSION_MISMATCH: 'A vector did not have the dimensions of its embedding space.',
  VECTOR_INVALID: 'The model produced an unusable vector.',
  VECTOR_COUNT_MISMATCH: 'The stored vectors did not match the document\'s chunks.',
  EMBEDDING_UNAVAILABLE: 'The embedding model could not run.',
  EMBEDDING_INPUT_TOO_LONG: 'A chunk was longer than the embedding model\'s window (it was not truncated).',
  EMBEDDING_BAD_OUTPUT: 'The embedding model returned malformed output.',
  NODE_UNAVAILABLE: 'The worker could not reach the application server.',
  INTERNAL_ERROR: 'An internal error occurred while embedding.',
  LOCK_EXPIRED: 'The worker stopped responding.',
  RESULT_MISMATCH: 'The worker\'s result did not match the document\'s chunks or the embedding space.',
  SUPERSEDED: 'A newer version of this document exists.',
  DOCUMENT_DELETED: 'The document was deleted.',
  NO_CHUNKS: 'The document has no chunks to embed.',
  INGESTION_NOT_INDEXED: 'The document has not been extracted yet.',
  SPACE_RETIRED: 'This embedding space is no longer in use.',
});

const LIMITS = Object.freeze({ maxPageChunks: 100, maxPageChars: 600_000 });

module.exports = {
  ANY_PIPELINE,
  EMBEDDING_KIND,
  EMBEDDING_PIPELINE,
  EMBEDDING_STATUS,
  FAIL_REASONS,
  LIMITS,
  MODELS,
  REASON_MESSAGES,
  SKIP_REASONS,
  WORKER_FAIL_REASONS,
  canonicalJson,
  describeSpace,
  spaceIdOf,
};
