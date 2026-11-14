/**
 * Document ingestion (Phase 3). The Python worker extracts and chunks; Node owns every durable fact.
 * Reason codes and the pipeline version are mirrored in ai/contracts/ingestion.json, which BOTH test suites read.
 */

// Must equal PIPELINE_VERSION in ai/app/ingestion/__init__.py. Bump both to re-ingest everything.
// p2 (Phase 4): chunks are sized with the embedding model's real tokenizer (~350 target / 450 max tokens) so they fit its
// 512-token window. p1 chunks stay until a document's p2 job is indexed (dropObsoleteChunks), so the old index is kept
// until migration of that document succeeds.
const INGESTION_PIPELINE_VERSION = 'p2';

const INGESTION_STATUS = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  INDEXED: 'indexed',
  FAILED: 'failed', // transient problem; will be retried when nextRunAt passes
  DEAD: 'dead', // retry budget exhausted; needs an administrator
  SKIPPED: 'skipped', // permanent content problem, with a reason; never silently "indexed"
});

// Extension -> extraction format. Anything else is skipped with UNSUPPORTED_FORMAT.
const INGESTION_FORMATS = Object.freeze({ pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', txt: 'txt', csv: 'csv' });

const SKIP_REASONS = Object.freeze({
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  ENCRYPTED: 'ENCRYPTED',
  NO_EXTRACTABLE_TEXT: 'NO_EXTRACTABLE_TEXT',
  EMPTY: 'EMPTY',
  CORRUPT: 'CORRUPT',
  TOO_MUCH_TEXT: 'TOO_MUCH_TEXT',
  ARCHIVE_LIMIT: 'ARCHIVE_LIMIT',
  // Node-decided, never sent by the worker:
  SUPERSEDED: 'SUPERSEDED', // a newer version of the document exists
  DOCUMENT_DELETED: 'DOCUMENT_DELETED', // trashed or removed
});

const FAIL_REASONS = Object.freeze({
  EXTRACTION_TIMEOUT: 'EXTRACTION_TIMEOUT',
  EXTRACTION_CRASHED: 'EXTRACTION_CRASHED',
  EXTRACTION_OOM: 'EXTRACTION_OOM',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  LOCK_EXPIRED: 'LOCK_EXPIRED', // the worker stopped heartbeating (crash / kill)
  STORAGE_MISSING: 'STORAGE_MISSING', // the blob for this version could not be read
});

// Reasons the WORKER may report (Node-decided ones are rejected if a worker sends them).
const WORKER_SKIP_REASONS = Object.freeze(Object.values(SKIP_REASONS).filter((r) => !['SUPERSEDED', 'DOCUMENT_DELETED'].includes(r)));
const WORKER_FAIL_REASONS = Object.freeze(['EXTRACTION_TIMEOUT', 'EXTRACTION_CRASHED', 'EXTRACTION_OOM', 'CHECKSUM_MISMATCH', 'DOWNLOAD_FAILED', 'INTERNAL_ERROR']);

// Safe, content-free wording for administrators.
const REASON_MESSAGES = Object.freeze({
  UNSUPPORTED_FORMAT: 'This file type is not indexed (legacy Office files, images and archives are not supported).',
  FILE_TOO_LARGE: 'The file is larger than the indexing size limit.',
  ENCRYPTED: 'The file is password-protected or encrypted.',
  NO_EXTRACTABLE_TEXT: 'The file has no extractable text (for example a scanned document that would need OCR).',
  EMPTY: 'The file has no content.',
  CORRUPT: 'The file is damaged or not a valid document of its type.',
  TOO_MUCH_TEXT: 'The file contains more text than the indexing limit allows.',
  ARCHIVE_LIMIT: 'The file exceeds structural safety limits (archive expansion, size or page count).',
  SUPERSEDED: 'A newer version of this document exists.',
  DOCUMENT_DELETED: 'The document was deleted.',
  EXTRACTION_TIMEOUT: 'Extraction took too long.',
  EXTRACTION_CRASHED: 'The extraction process failed.',
  EXTRACTION_OOM: 'Extraction ran out of memory.',
  CHECKSUM_MISMATCH: 'The downloaded file did not match its recorded checksum.',
  DOWNLOAD_FAILED: 'The worker could not download the file.',
  INTERNAL_ERROR: 'An internal error occurred during extraction.',
  LOCK_EXPIRED: 'The worker stopped responding.',
  STORAGE_MISSING: 'The stored file could not be read.',
});

const LIMITS = Object.freeze({
  maxChunksPerDocument: 3000,
  maxChunkChars: 8000, // a chunk is ~3200 chars by design; this is a hard validation ceiling
  maxResultChars: 6 * 1024 * 1024,
  maxHeadingDepth: 12,
  maxHeadingChars: 300,
});

module.exports = {
  FAIL_REASONS,
  INGESTION_FORMATS,
  INGESTION_PIPELINE_VERSION,
  INGESTION_STATUS,
  LIMITS,
  REASON_MESSAGES,
  SKIP_REASONS,
  WORKER_FAIL_REASONS,
  WORKER_SKIP_REASONS,
};
