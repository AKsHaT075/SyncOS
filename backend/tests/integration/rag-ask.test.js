jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));

/**
 * POST /api/v1/ai/ask: the entry point. A fake engine stands in for Python and calls the REAL authorization endpoint with the
 * REAL per-request callback token, so the metering pipeline, the citation re-check and the user-facing shape are real.
 */
const crypto = require('crypto');
const http = require('http');
const mongoose = require('mongoose');
const request = require('supertest');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createIndexedDocument, ensureIndexes } = require('../helpers/ingestionHelpers');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { describeSpace } = require('../../src/constants/embedding.constants');
const AiEmbeddingConfig = require('../../src/models/AiEmbeddingConfig');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const AiUsageEvent = require('../../src/models/AiUsageEvent');
const Document = require('../../src/models/Document');
const DocumentChunk = require('../../src/models/DocumentChunk');
const DocumentIngestionJob = require('../../src/models/DocumentIngestionJob');
const DocumentVersion = require('../../src/models/DocumentVersion');
const EmbeddingJob = require('../../src/models/EmbeddingJob');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const tokens = require('../../src/services/ai/aiService/tokens');
const { createInternalApp } = require('../../src/internalApp');
const { createKeyPair } = require('../helpers/stubAiService');
const { createFakeProvider } = require('../helpers/fakeAiProvider');

const { users, createUser, makeAgent, as, app } = createHarness();
const internal = createInternalApp();
const pair = createKeyPair();
const E5 = describeSpace('multilingual-e5-small');
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const KEYS = ['emp', 'colleague', 'guest', 'superadmin', 'empB'];
const saved = {};
let orgA; let orgB;

/** Stands in for Python: authorizes through Node with the per-request callback token, then "answers" from what it was given. */
function pythonLike() {
  const fake = createFakeProvider();
  const engine = {
    ...fake,
    seen: [],
    plan: { forgeCitation: false, noContext: false, failAfterText: false, hang: false },
    async status() {
      return { reachable: true, configured: true, provider: 'groq', models: { chat: 'openai/gpt-oss-120b', summarize: 'openai/gpt-oss-120b' }, version: 'test', replayStore: 'memory' };
    },
    async* chat(params) {
      engine.seen.push(params);
      if (!params.rag) return yield* fake.chat(params);
      const { identity } = params;
      const callback = tokens.signCallbackToken({ ...identity, scopes: [tokens.CALLBACK_SCOPES.KNOWLEDGE_AUTHORIZE] });
      const chunks = await DocumentChunk.find({ organization: identity.orgId, pipelineVersion: 'p2' }).sort({ document: 1, chunkIndex: 1 }).lean();
      // (real Python never asks about zero candidates: it skips the call)
      const res = chunks.length === 0
        ? { status: 200, body: { items: [], rejected: 0 } }
        : await request(internal).post('/internal/ai/knowledge/authorize').set('Authorization', `Bearer ${callback}`).send({ candidates: chunks.slice(0, 50).map((c) => ({ documentId: c.document.toString(), version: c.version, chunkIndex: c.chunkIndex, textHash: c.textHash })) });
      if (res.status !== 200) {
        const { make } = require('../../src/services/ai/aiService/errors');
        throw make('AI_RETRIEVAL_UNAVAILABLE');
      }
      const items = res.body.items;
      yield { type: 'retrieval', candidates: chunks.length, authorized: items.length, rejected: res.body.rejected, belowThreshold: 7, duplicates: 0, used: items.length, rounds: 1, topScore: 0.9 };
      if (engine.plan.noContext || items.length === 0) {
        yield { type: 'text', text: 'I could not find information about this in the documents you have access to.' };
        yield { type: 'usage', inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false };
        yield { type: 'citations', citations: [], unverifiedMarkers: [], consideredSources: 0, uncited: true };
        yield { type: 'done', finishReason: 'no_context', model: null, provider: 'groq', requestId: null, firstEventMs: 0 };
        return;
      }
      yield { type: 'text', text: `Answer from ${items.map((_, i) => `[${i + 1}]`).join('')}` };
      if (engine.plan.failAfterText) {
        const { make } = require('../../src/services/ai/aiService/errors');
        throw make('AI_SERVICE_UNAVAILABLE', { streamStarted: true });
      }
      if (engine.plan.hang) await new Promise((resolve) => params.signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'usage', inputTokens: 900, outputTokens: 40, totalTokens: 940, estimated: false };
      const citations = items.map((it, i) => ({ n: i + 1, chunkId: it.chunkId, documentId: it.documentId, documentName: it.documentName, version: it.version, chunkIndex: it.chunkIndex, location: it.location, score: 0.9 }));
      if (engine.plan.forgeCitation) citations.push({ n: 9, chunkId: oid().toString(), documentId: oid().toString(), documentName: 'FORGED-DOCUMENT.docx', version: 1, chunkIndex: 0, location: {}, score: 0.99 });
      yield { type: 'citations', citations, unverifiedMarkers: [], consideredSources: items.length, uncited: false };
      yield { type: 'done', finishReason: 'stop', model: 'openai/gpt-oss-120b', provider: 'groq', requestId: 'r', firstEventMs: 3 };
    },
  };
  return engine;
}
const engine = pythonLike();

async function doc(texts, over = {}) {
  const made = await createIndexedDocument({ organization: orgA, owner: users.emp, texts, ...over });
  await EmbeddingJob.create({ organization: orgA._id, document: made.doc._id, kind: 'embed', version: 1, ingestionPipeline: 'p2', spaceId: E5.id, status: 'completed', chunkCount: texts.length, digest: 'd'.repeat(64) });
  return made;
}
const ask = (key, body, accept) => {
  const r = as(key).post('/api/v1/ai/ask');
  if (accept) r.set('Accept', accept);
  return r.send(body);
};
const events = (text) => text.trim().split('\n\n').map((b) => JSON.parse(b.split('data: ')[1]));

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await ensureIndexes();
  await Promise.all(KEYS.map(makeAgent));
  for (const k of ['AI_SERVICE_SIGNING_KEY', 'AI_RAG_CONTEXT_TOKENS', 'AI_MAX_OUTPUT_TOKENS']) saved[k] = env[k];
  aiService.setEngine(engine);
});
afterAll(async () => {
  Object.assign(env, saved);
  aiService.resetEngine();
  await hub.shutdown();
  const found = await redis().keys('test:ai:*');
  if (found.length) await redis().del(found);
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  engine.seen.length = 0;
  engine.plan = { forgeCitation: false, noContext: false, failAfterText: false, hang: false };
  engine.reset?.();
  aiService.invalidateStatus();
  env.AI_SERVICE_SIGNING_KEY = pair.privateKey;
  env.AI_GLOBAL_ENABLED = true;
  env.AI_RATE_LIMIT_PER_MINUTE = 1000;
  env.AI_MAX_CONCURRENT_PER_USER = 50;
  env.AI_MAX_OUTPUT_TOKENS = 200;
  await Promise.all([AiEmbeddingConfig, AiOrgSettings, AiUsageEvent, Document, DocumentChunk, DocumentIngestionJob, DocumentVersion, EmbeddingJob, Organization, User].map((m) => m.deleteMany({})));
  const found = await redis().keys('test:ai:*');
  if (found.length) await redis().del(found);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'emp', ROLES.EMPLOYEE);
  await createUser(orgA, 'colleague', ROLES.EMPLOYEE);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'empB', ROLES.EMPLOYEE);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true }, { organization: orgB._id, enabled: true }]);
  await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: E5.id, spaces: { [E5.id]: E5.descriptor } });
});

describe('the answer, as the user receives it', () => {
  test('JSON: answer, confirmed citations (name, version, chunk id, location) and a privacy-safe retrieval summary', async () => {
    const made = await doc(['Leave is 24 days.', 'Carry over 5 days.']);
    const res = await ask('colleague', { question: 'How much leave do I get?' }).expect(200);
    expect(res.body.answer).toMatch(/Answer from \[1\]\[2\]/);
    expect(res.body.citations).toHaveLength(2);
    expect(res.body.citations[0]).toMatchObject({ n: 1, documentId: made.doc._id.toString(), documentName: made.doc.name, version: 1, chunkIndex: 0, location: { charStart: 0, charEnd: 9 } });
    expect(res.body.citations[0].chunkId).toBe((await DocumentChunk.findOne({ document: made.doc._id, chunkIndex: 0 }))._id.toString());
    expect(res.body.retrieval).toEqual({ sourcesUsed: 2 }); // NOT how many candidates were refused or fell below the threshold
    expect(res.body.droppedCitations).toBe(0);
    expect(JSON.stringify(res.body)).not.toMatch(/rejected|belowThreshold|candidates/);
  });

  test('SSE: the same events as a stream, with the same privacy-safe shape', async () => {
    await doc(['Leave is 24 days.']);
    const res = await ask('colleague', { question: 'How much leave?' }, 'text/event-stream').buffer(true).parse((r, cb) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => cb(null, t)); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-store');
    const ev = events(res.body);
    expect(ev.map((e) => e.type)).toEqual(['retrieval', 'text', 'usage', 'citations', 'done']);
    expect(ev[0]).toEqual({ type: 'retrieval', sourcesUsed: 1 });
    expect(ev.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(res.body).not.toMatch(/rejected|belowThreshold/);
  });

  test('a citation Node did not authorize for THIS request is dropped, whatever Python or the model produced', async () => {
    await doc(['Leave is 24 days.']);
    engine.plan.forgeCitation = true;
    const res = await ask('colleague', { question: 'q?' }).expect(200);
    expect(res.body.citations.map((c) => c.documentName)).not.toContain('FORGED-DOCUMENT.docx');
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.droppedCitations).toBe(1);
  });

  test('when nothing can be used the user gets the fixed "not found" answer, no citations, and nothing is charged', async () => {
    await doc(['Hidden.'], { visibility: 'private', owner: users.emp });
    const res = await ask('colleague', { question: 'What is hidden?' }).expect(200);
    expect(res.body.answer).toMatch(/could not find/i);
    expect(res.body.citations).toEqual([]);
    expect(res.body.retrieval).toEqual({ sourcesUsed: 0 });
    const [event] = await AiUsageEvent.find({}).lean();
    expect(event).toMatchObject({ feature: 'document_qa', status: 'success', chargedTokens: 0, totalTokens: 0 });
  });

  test('another tenant\'s question sees none of this tenant\'s documents', async () => {
    await doc(['Acme secret policy.']);
    const res = await ask('empB', { question: 'What is the policy?' }).expect(200);
    expect(res.body.citations).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('Acme');
  });
});

describe('metering and the engine contract', () => {
  test('quota is reserved for the retrieved context, then settled to the real usage; one usage row, content-free', async () => {
    await doc(['Leave is 24 days.']);
    await ask('colleague', { question: 'How much leave?' }).expect(200);
    const rows = await AiUsageEvent.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature: 'document_qa', status: 'success', inputTokens: 900, outputTokens: 40, chargedTokens: 940, quotaSettled: true });
    expect(rows[0].reservedTokens).toBeGreaterThanOrEqual(env.AI_RAG_CONTEXT_TOKENS + 200); // room for the sources AND the answer
    expect(JSON.stringify(rows)).not.toMatch(/Leave is 24 days|How much leave/);
  });

  test('the engine is told the ACTIVE embedding space and the question - and nothing else about the user', async () => {
    await doc(['Leave is 24 days.']);
    await ask('colleague', { question: 'How much leave?' }).expect(200);
    const call = engine.seen.find((c) => c.rag);
    expect(call.rag).toEqual({ question: 'How much leave?', spaceId: E5.id });
    expect(call.identity).toEqual({ userId: users.colleague._id.toString(), orgId: orgA._id.toString(), requestKey: expect.any(String) });
  });

  test('the same request key is used for metering and for the callback token\'s request id', async () => {
    await doc(['Leave is 24 days.']);
    await ask('colleague', { question: 'q?' }).expect(200);
    const call = engine.seen.find((c) => c.rag);
    expect((await AiUsageEvent.findOne({})).requestKey).toBe(call.identity.requestKey);
  });

  test('a failure while streaming ends the SSE with a safe error event and records the failure', async () => {
    await doc(['Leave is 24 days.']);
    engine.plan.failAfterText = true;
    const res = await ask('colleague', { question: 'q?' }, 'text/event-stream').buffer(true).parse((r, cb) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => cb(null, t)); });
    const ev = events(res.body);
    expect(ev.at(-1)).toMatchObject({ type: 'error', code: 'AI_SERVICE_UNAVAILABLE' });
    expect(JSON.stringify(ev.at(-1))).not.toMatch(/stack|mongo|redis/i);
    expect(await AiUsageEvent.findOne({})).toMatchObject({ status: 'error', streamStarted: true, tokensEstimated: true });
  });

  test('a client that disconnects mid-answer cancels it and settles the quota', async () => {
    await doc(['Leave is 24 days.']);
    engine.plan.hang = true;
    await new Promise((resolve) => {
      ask('colleague', { question: 'q?' }, 'text/event-stream')
        .buffer(false)
        .parse((res, cb) => {
          res.once('data', () => { // the first event arrived: the browser goes away
            res.destroy();
            cb(null, null);
            resolve();
          });
        })
        .end(() => {});
    });
    const end = Date.now() + 8000;
    while (!(await AiUsageEvent.countDocuments()) && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); // eslint-disable-line no-await-in-loop
    expect(await AiUsageEvent.findOne({})).toMatchObject({ status: 'cancelled', quotaSettled: true });
    expect(await redis().zCard(`test:ai:rl:{${orgA._id}}:c:${users.colleague._id}`)).toBe(0);
  });
});

describe('access control and validation', () => {
  test('no active embedding space => 503 AI_KNOWLEDGE_NOT_READY before anything is reserved or sent', async () => {
    await AiEmbeddingConfig.updateOne({ _id: 'embedding' }, { activeSpaceId: null, targetSpaceId: E5.id });
    const res = await ask('colleague', { question: 'q?' }).expect(503);
    expect(res.body.code).toBe('AI_KNOWLEDGE_NOT_READY');
    expect(engine.seen.filter((c) => c.rag)).toHaveLength(0);
    expect(await AiUsageEvent.countDocuments()).toBe(0);
  });

  test.each([['guest'], ['superadmin']])('%s cannot ask', async (key) => {
    await ask(key, { question: 'q?' }).expect(403);
    expect(engine.seen.filter((c) => c.rag)).toHaveLength(0);
  });

  test('unauthenticated requests are refused', async () => {
    expect((await request(app).post('/api/v1/ai/ask').send({ question: 'q?' })).status).toBeGreaterThanOrEqual(401);
  });

  test('AI switched off for the organization stops the question before retrieval', async () => {
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: false });
    const res = await ask('colleague', { question: 'q?' });
    expect(res.status).toBe(403);
    expect(engine.seen.filter((c) => c.rag)).toHaveLength(0);
  });

  test.each([
    [{ question: '' }], [{ question: '   ' }], [{ question: 'x'.repeat(2001) }], [{}], [{ question: 7 }],
    [{ question: 'q?', organization: 'x' }], [{ question: 'q?', documentIds: ['a'] }], [{ question: 'q?', spaceId: 'abcdef123456' }], [{ question: 'q?', topK: 50 }],
  ])('invalid body %j is rejected before any work', async (body) => {
    expect((await ask('colleague', body)).status).toBe(400);
    expect(engine.seen.filter((c) => c.rag)).toHaveLength(0);
  });

  test('the user, organization and index come from the session: a body cannot change them', async () => {
    await doc(['Acme leave.']);
    const res = await ask('empB', { question: 'q?', organization: orgA._id.toString() });
    expect(res.status).toBe(400);
  });

  test('rate limiting still applies to questions', async () => {
    await doc(['Leave is 24 days.']);
    env.AI_RATE_LIMIT_PER_MINUTE = 1;
    await ask('colleague', { question: 'one?' }).expect(200);
    const second = await ask('colleague', { question: 'two?' });
    expect(second.status).toBe(429);
  });
});
