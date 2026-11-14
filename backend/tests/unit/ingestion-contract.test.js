const fs = require('fs');
const path = require('path');
const C = require('../../src/constants/ingestion.constants');
const { ALLOWED_FILE_TYPES } = require('../../src/constants/document.constants');
const DocumentChunk = require('../../src/models/DocumentChunk');

const contract = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../ai/contracts/ingestion.json'), 'utf8'));
const sorted = (a) => [...a].sort();

describe('Node and Python agree on the ingestion contract (ai/contracts/ingestion.json)', () => {
  test('pipeline version', () => expect(C.INGESTION_PIPELINE_VERSION).toBe(contract.pipelineVersion));
  test('supported formats', () => expect(sorted(Object.values(C.INGESTION_FORMATS))).toEqual(sorted(contract.formats)));
  test('job statuses', () => expect(sorted(Object.values(C.INGESTION_STATUS))).toEqual(sorted(contract.statuses)));
  test('skip reasons the worker may report', () => expect(sorted(C.WORKER_SKIP_REASONS)).toEqual(sorted(contract.skipReasons)));
  test('failure reasons the worker may report', () => expect(sorted(C.WORKER_FAIL_REASONS)).toEqual(sorted(contract.failReasons)));
  test('every reason has an administrator-facing message', () => {
    for (const r of [...contract.skipReasons, ...contract.failReasons, 'SUPERSEDED', 'DOCUMENT_DELETED', 'LOCK_EXPIRED', 'STORAGE_MISSING']) expect(C.REASON_MESSAGES[r]).toBeTruthy();
  });
  test('chunk location keys match the stored schema', () => {
    expect(sorted(Object.keys(DocumentChunk.schema.path('location').schema.paths).filter((k) => k !== '_id'))).toEqual(sorted(contract.chunkLocationKeys));
  });
  test('unsupported extensions are really uploadable types that ingestion declines', () => {
    for (const ext of contract.unsupportedExtensions) {
      expect(C.INGESTION_FORMATS[ext]).toBeUndefined();
      expect(Boolean(ALLOWED_FILE_TYPES[ext])).toBe(true); // they CAN be uploaded; they are skipped with a reason, not lost
    }
  });
  test('every uploadable type is either extracted or explicitly declined', () => {
    for (const ext of Object.keys(ALLOWED_FILE_TYPES)) expect(C.INGESTION_FORMATS[ext] || contract.unsupportedExtensions.includes(ext)).toBeTruthy();
  });
});
