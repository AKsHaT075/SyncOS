const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const Document = require('../../src/models/Document');
const DocumentVersion = require('../../src/models/DocumentVersion');
const DocumentChunk = require('../../src/models/DocumentChunk');
const DocumentIngestionJob = require('../../src/models/DocumentIngestionJob');
const { getStorage, generateStorageKey } = require('../../src/storage');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const CATEGORY = { pdf: 'pdf', docx: 'word', xlsx: 'excel', pptx: 'powerpoint', txt: 'text', csv: 'csv', doc: 'word', xls: 'excel', ppt: 'powerpoint', zip: 'archive', png: 'image', jpg: 'image' };

async function putBlob(organization, buffer) {
  const tmp = path.join(os.tmpdir(), `ing-${crypto.randomUUID()}`);
  fs.writeFileSync(tmp, buffer);
  const key = generateStorageKey(organization);
  await getStorage().put(key, tmp);
  return key;
}

/** A real Document + DocumentVersion v1 whose bytes really are in storage. */
async function createStoredDocument({ organization, owner, ext = 'txt', content = Buffer.from('hello world, this is a document'), name, visibility = 'organization' }) {
  const storageKey = await putBlob(organization._id, content);
  const checksum = sha256(content);
  const doc = await Document.create({
    organization: organization._id,
    name: name || `Doc-${crypto.randomBytes(3).toString('hex')}.${ext}`,
    owner: owner._id,
    visibility,
    extension: ext,
    category: CATEGORY[ext] || 'text',
    mimeType: 'application/octet-stream',
    size: content.length,
    checksum,
    storageKey,
    currentVersion: 1,
    versionSeq: 1,
  });
  await DocumentVersion.create({ organization: organization._id, document: doc._id, version: 1, storageKey, fileName: doc.name, mimeType: doc.mimeType, size: content.length, checksum, uploadedBy: owner._id });
  return doc;
}

/** Adds version N+1 the way the real code does (new blob, document points at it). */
async function addVersion(doc, content) {
  const next = doc.currentVersion + 1;
  const storageKey = await putBlob(doc.organization, content);
  const checksum = sha256(content);
  await DocumentVersion.create({ organization: doc.organization, document: doc._id, version: next, storageKey, fileName: doc.name, mimeType: doc.mimeType, size: content.length, checksum, uploadedBy: doc.owner });
  await Document.updateOne({ _id: doc._id }, { $set: { currentVersion: next, versionSeq: next, storageKey, size: content.length, checksum } });
  return Document.findById(doc._id);
}

/** The worker's key pair + a signer that produces tokens exactly like ai/app/ingestion/auth.py. */
function createWorkerKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicPem: publicKey.export({ type: 'spki', format: 'pem' }) };
}

function signWorkerToken(privatePem, over = {}) {
  const { alg = 'ES256', kid = 'w1', aud = 'syncos-node:ingestion', iss = 'syncos-ai-worker', lifetime = 30, key = privatePem, claims = {} } = over;
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss, aud, sub: 'worker-test', iat: now, nbf: now, exp: now + lifetime, jti: crypto.randomUUID().replace(/-/g, ''), ...claims };
  return jwt.sign(payload, key, { algorithm: alg, keyid: kid });
}

/**
 * A document whose CURRENT version has been extracted (as the ingestion worker would leave it): an `indexed` p2
 * ingestion job plus real chunk rows. Returns { doc, chunks }.
 */
async function createIndexedDocument({ organization, owner, chunks = 3, texts = null, version = null, doc = null, tag = 'chunk', ...rest }) {
  const document = doc || (await createStoredDocument({ organization, owner, ...rest }));
  const v = version || document.currentVersion;
  const count = texts ? texts.length : chunks;
  const rows = Array.from({ length: count }, (_, i) => {
    const text = texts ? texts[i] : `${tag} ${i} of ${document._id} v${v}: leave policy text`;
    return { organization: organization._id, document: document._id, version: v, pipelineVersion: 'p2', chunkIndex: i, text, textHash: sha256(Buffer.from(text)), tokenEstimate: 8, location: { charStart: i * 10, charEnd: i * 10 + 9 } };
  });
  if (rows.length) await DocumentChunk.insertMany(rows);
  await DocumentIngestionJob.updateOne(
    { organization: organization._id, document: document._id, version: v, pipelineVersion: 'p2' },
    { $set: { status: 'indexed', checksum: document.checksum, format: 'txt', extension: document.extension, size: document.size, finishedAt: new Date(), stats: { chunkCount: count } } },
    { upsert: true },
  );
  return { doc: document, chunks: rows };
}

/**
 * Waits until the unique indexes of the ingestion/embedding collections exist. On a freshly created test database the
 * first test could otherwise race the background index build and see duplicates that a real deployment (indexes built
 * at startup) cannot produce.
 */
async function ensureIndexes() {
  const models = [DocumentChunk, DocumentIngestionJob, require('../../src/models/EmbeddingJob'), require('../../src/models/AiEmbeddingConfig'), Document, DocumentVersion];
  await Promise.all(models.map((m) => m.init()));
}

module.exports = { ensureIndexes, createIndexedDocument, addVersion, createStoredDocument, createWorkerKeys, putBlob, sha256, signWorkerToken };
