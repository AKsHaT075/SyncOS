const fs = require('fs');
const path = require('path');
const C = require('../../src/constants/embedding.constants');
const { INGESTION_PIPELINE_VERSION } = require('../../src/constants/ingestion.constants');
const EmbeddingJob = require('../../src/models/EmbeddingJob');

const contract = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../ai/contracts/embedding.json'), 'utf8'));
const sorted = (a) => [...a].sort();

describe('Node and Python agree on the embedding contract (ai/contracts/embedding.json)', () => {
  test('pipelines', () => {
    expect(C.EMBEDDING_PIPELINE).toBe(contract.embeddingPipeline);
    expect(INGESTION_PIPELINE_VERSION).toBe(contract.ingestionPipeline);
  });

  test('every embedding space has the SAME descriptor and the SAME id in both languages (golden values)', () => {
    expect(sorted(Object.keys(C.MODELS))).toEqual(sorted(Object.keys(contract.spaces)));
    for (const key of Object.keys(contract.spaces)) {
      const space = C.describeSpace(key, contract.ingestionPipeline);
      expect(space.descriptor).toEqual(contract.spaces[key].descriptor);
      expect(space.id).toBe(contract.spaces[key].spaceId);
    }
  });

  test('any change to any descriptor field changes the space id (so incompatible vectors never share a space)', () => {
    const base = C.describeSpace('multilingual-e5-small');
    const variants = { model: 'x/y', revision: 'abc', modelFile: 'onnx/model_O4.onnx', dimensions: 768, pooling: 'cls', normalize: false, queryPrefix: '', passagePrefix: '', maxTokens: 256, distance: 'dot', embeddingPipeline: 'e2', ingestionPipeline: 'p3', provider: 'other' };
    for (const [field, value] of Object.entries(variants)) {
      expect(C.spaceIdOf({ ...base.descriptor, [field]: value })).not.toBe(base.id);
    }
    expect(C.describeSpace('multilingual-e5-small', 'p3').id).not.toBe(base.id);
    expect(C.describeSpace('nope')).toBeNull();
  });

  test('canonical JSON is key-order independent and compact', () => {
    expect(C.canonicalJson({ b: 1, a: [true, 'é'] })).toBe('{"a":[true,"é"],"b":1}');
    expect(C.spaceIdOf({ a: 1, b: 2 })).toBe(C.spaceIdOf({ b: 2, a: 1 }));
  });

  test('statuses, kinds and reason codes', () => {
    expect(sorted(Object.values(C.EMBEDDING_STATUS))).toEqual(sorted(contract.statuses));
    expect(sorted(Object.values(C.EMBEDDING_KIND))).toEqual(sorted(contract.kinds));
    expect(sorted(C.WORKER_FAIL_REASONS)).toEqual(sorted(contract.failReasons));
    for (const r of [...contract.failReasons, ...contract.nodeReasons]) expect(C.REASON_MESSAGES[r]).toBeTruthy();
    expect(contract.nodeReasons.filter((r) => Object.values(C.FAIL_REASONS).includes(r) || Object.values(C.SKIP_REASONS).includes(r))).toHaveLength(contract.nodeReasons.length);
  });

  test('the e5 model is pinned and carries the documented prefixes', () => {
    const m = C.MODELS['multilingual-e5-small'];
    expect(m).toMatchObject({ model: 'intfloat/multilingual-e5-small', revision: '614241f622f53c4eeff9890bdc4f31cfecc418b3', dimensions: 384, pooling: 'mean', normalize: true, queryPrefix: 'query: ', passagePrefix: 'passage: ', maxTokens: 512 });
  });

  test('the job row holds no text or vectors', () => {
    const paths = Object.keys(EmbeddingJob.schema.paths);
    for (const forbidden of ['text', 'vector', 'embedding', 'vectors', 'content']) expect(paths).not.toContain(forbidden);
  });
});
