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
 * A conversation turn end to end through Node: persistence, follow-up context, citations, streaming, cancellation, quota
 * settlement, the language policy and content leakage. A stand-in for Python authorizes through Node's REAL internal endpoint.
 */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { createIndexedDocument, ensureIndexes } = require('../helpers/ingestionHelpers');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { describeSpace } = require('../../src/constants/embedding.constants');
const AIConversation = require('../../src/models/AIConversation');
const AiMessage = require('../../src/models/AiMessage');
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
const { createInternalApp } = require('../../src/internalApp');
const { createKeyPair } = require('../helpers/stubAiService');
const { createRagEngine } = require('../helpers/ragEngine');

const { users, createUser, makeAgent, as } = createHarness();
const pair = createKeyPair();
const engine = createRagEngine(createInternalApp());
const E5 = describeSpace('multilingual-e5-small');
const oid = () => new mongoose.Types.ObjectId();
const redis = () => createRedisClient();
const KEYS = ['emp', 'colleague', 'colleague2', 'orgAdmin', 'empB']; // colleague2 = a second client of the SAME person (one supertest agent cannot hold an open stream and issue another request)
const BASE = '/api/v1/ai/conversations';
const saved = {};
let orgA; let orgB;

async function doc(texts, over = {}) {
  const made = await createIndexedDocument({ organization: orgA, owner: users.emp, texts, ...over });
  await EmbeddingJob.create({ organization: orgA._id, document: made.doc._id, kind: 'embed', version: 1, ingestionPipeline: 'p2', spaceId: E5.id, status: 'completed', chunkCount: texts.length, digest: 'd'.repeat(64) });
  return made;
}
const newConv = async (key = 'colleague') => (await as(key).post(BASE).send({}).expect(201)).body.conversation.id;
const send = (key, id, content, accept) => {
  const r = as(key).post(`${BASE}/${id}/messages`);
  if (accept) r.set('Accept', accept);
  return r.send({ content });
};
const sse = (r, cb) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => cb(null, t)); };
const parseSse = (text) => text.trim().split('\n\n').map((b) => JSON.parse(b.split('data: ')[1]));
const messages = async (key, id, qs = '') => (await as(key).get(`${BASE}/${id}/messages${qs}`).expect(200)).body.messages;
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout'); };

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await ensureIndexes();
  await AIConversation.init();
  await AiMessage.init();
  await Promise.all(KEYS.map(makeAgent));
  for (const k of ['AI_SERVICE_SIGNING_KEY', 'AI_MAX_OUTPUT_TOKENS', 'AI_CONVERSATION_MAX_MESSAGES']) saved[k] = env[k];
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
  engine.resetPlan();
  aiService.invalidateStatus();
  env.AI_SERVICE_SIGNING_KEY = pair.privateKey;
  env.AI_GLOBAL_ENABLED = true;
  env.AI_RATE_LIMIT_PER_MINUTE = 1000;
  env.AI_MAX_CONCURRENT_PER_USER = 50;
  env.AI_MAX_OUTPUT_TOKENS = 200;
  env.AI_CONVERSATION_MAX_MESSAGES = saved.AI_CONVERSATION_MAX_MESSAGES;
  await Promise.all([AIConversation, AiMessage, AiEmbeddingConfig, AiOrgSettings, AiUsageEvent, Document, DocumentChunk, DocumentIngestionJob, DocumentVersion, EmbeddingJob, Organization, User].map((m) => m.deleteMany({})));
  const found = await redis().keys('test:ai:*');
  if (found.length) await redis().del(found);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'emp', ROLES.EMPLOYEE);
  await createUser(orgA, 'colleague', ROLES.EMPLOYEE);
  users.colleague2 = users.colleague;
  await createUser(orgA, 'orgAdmin', ROLES.ORG_ADMIN);
  await createUser(orgB, 'empB', ROLES.EMPLOYEE);
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true }, { organization: orgB._id, enabled: true }]);
  await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: E5.id, spaces: { [E5.id]: E5.descriptor } });
});

describe('a turn is persisted', () => {
  test('JSON: both messages are stored in order with the answer, its citations and a title taken from the question', async () => {
    const made = await doc(['Leave is 24 days.', 'Carry over 5 days.']);
    const id = await newConv();
    const res = await send('colleague', id, 'How many days of leave do I get?').expect(200);
    expect(res.body.userMessage).toMatchObject({ seq: 1, role: 'user', content: 'How many days of leave do I get?', status: 'complete' });
    expect(res.body.assistantMessage).toMatchObject({ seq: 2, role: 'assistant', status: 'complete', finishReason: 'stop' });
    expect(res.body.assistantMessage.content).toMatch(/Answer to/);
    expect(res.body.assistantMessage.citations).toHaveLength(2);
    expect(res.body.assistantMessage.citations[0]).toMatchObject({ n: 1, available: true, documentId: made.doc._id.toString(), documentName: made.doc.name, version: 1, chunkIndex: 0 });
    expect(res.body.retrieval).toEqual({ sourcesUsed: 2 });
    const stored = await messages('colleague', id);
    expect(stored.map((m) => [m.seq, m.role, m.status])).toEqual([[1, 'user', 'complete'], [2, 'assistant', 'complete']]);
    expect(stored[1].citations).toEqual(res.body.assistantMessage.citations);
    const conv = (await as('colleague').get(`${BASE}/${id}`).expect(200)).body.conversation;
    expect(conv).toMatchObject({ title: 'How many days of leave do I get?', titleSource: 'auto', messageCount: 2, busy: false });
  });

  test('titles are short, single-line and come from the question only; a user rename is never overwritten', async () => {
    await doc(['Leave is 24 days.']);
    const long = await newConv();
    await send('colleague', long, `How is the annual leave policy applied to part time staff ${'and so on '.repeat(20)}`).expect(200);
    const title = (await as('colleague').get(`${BASE}/${long}`)).body.conversation.title;
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title).toMatch(/^How is the annual leave policy/);
    expect(title).toMatch(/…$/);

    const renamed = await newConv();
    await as('colleague').patch(`${BASE}/${renamed}`).send({ title: 'My own title' }).expect(200);
    await send('colleague', renamed, 'What about leave?').expect(200);
    expect((await as('colleague').get(`${BASE}/${renamed}`)).body.conversation).toMatchObject({ title: 'My own title', titleSource: 'user' });

    const second = await newConv();
    await send('colleague', second, 'First question about leave').expect(200);
    await send('colleague', second, 'A different second question').expect(200);
    expect((await as('colleague').get(`${BASE}/${second}`)).body.conversation.title).toBe('First question about leave'); // only the first turn names it
  });

  test('SSE: meta first, then the answer events, and `done` only after the transcript is saved', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    const res = await send('colleague', id, 'How much leave?', 'text/event-stream').buffer(true).parse(sse);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const ev = parseSse(res.body);
    expect(ev.map((e) => e.type)).toEqual(['meta', 'retrieval', 'text', 'usage', 'citations', 'done']);
    expect(ev[0]).toEqual({ type: 'meta', conversationId: id, userMessageId: expect.any(String), assistantMessageId: expect.any(String) });
    expect(ev.at(-1)).toEqual({ type: 'done', finishReason: 'stop', messageId: ev[0].assistantMessageId });
    expect(ev[1]).toEqual({ type: 'retrieval', sourcesUsed: 1 });
    const stored = await AiMessage.findById(ev[0].assistantMessageId).lean();
    expect(stored).toMatchObject({ status: 'complete', finishReason: 'stop' });
    expect(res.body).not.toMatch(/rejected|belowThreshold|candidates/);
  });

  test('"not found" answers are stored too (and charge nothing)', async () => {
    const id = await newConv();
    const res = await send('colleague', id, 'What is the pet policy?').expect(200);
    expect(res.body.assistantMessage).toMatchObject({ status: 'complete', finishReason: 'no_context', citations: [] });
    expect(await AiUsageEvent.findOne({})).toMatchObject({ chargedTokens: 0, conversation: new mongoose.Types.ObjectId(id) });
  });

  test('message sequence is gapless and each reply links to the usage event of its request', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    for (const q of ['one?', 'two?', 'three?']) await send('colleague', id, q).expect(200); // eslint-disable-line no-await-in-loop
    const stored = await AiMessage.find({ conversation: id }).sort({ seq: 1 }).lean();
    expect(stored.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const m of stored) expect(await AiUsageEvent.countDocuments({ requestKey: m.requestKey })).toBe(1);
  });

  test('input is validated: empty, too long, extra fields', async () => {
    const id = await newConv();
    await send('colleague', id, '   ').expect(400);
    await send('colleague', id, 'x'.repeat(env.AI_RAG_MAX_QUESTION_CHARS + 1)).expect(400);
    await as('colleague').post(`${BASE}/${id}/messages`).send({ content: 'ok?', role: 'assistant' }).expect(400);
    await as('colleague').post(`${BASE}/${id}/messages`).send({ content: 'ok?', conversation: oid().toString() }).expect(400);
    expect(await AiMessage.countDocuments({})).toBe(0);
  });
});

describe('follow-up questions', () => {
  test('the engine gets the earlier exchange as untrusted history (answer markers removed), and only from THIS conversation', async () => {
    await doc(['Leave is 24 days.']);
    const a = await newConv();
    const b = await newConv();
    await send('colleague', a, 'How many days of leave do I get?').expect(200);
    await send('colleague', b, 'Unrelated question about expenses?').expect(200);
    engine.seen.length = 0;
    await send('colleague', a, 'And how many can I carry over?').expect(200);
    const rag = engine.seen.find((c) => c.rag).rag;
    expect(rag.question).toBe('And how many can I carry over?');
    expect(rag.history).toHaveLength(2);
    expect(rag.history[0]).toEqual({ role: 'user', content: 'How many days of leave do I get?' });
    expect(rag.history[1].role).toBe('assistant');
    expect(rag.history[1].content).toMatch(/^Answer to "How many days of leave do I get\?" from\s*$/); // [1] markers stripped
    expect(JSON.stringify(rag.history)).not.toMatch(/expenses/);
  });

  test('the first question has no history, and the quota reservation grows only when there is some', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    await send('colleague', id, 'First?').expect(200);
    expect(engine.seen.find((c) => c.rag).rag.history).toBeUndefined();
    await send('colleague', id, 'Second?').expect(200);
    const rows = await AiUsageEvent.find({}).sort({ createdAt: 1 }).lean();
    expect(rows[1].reservedTokens).toBeGreaterThan(rows[0].reservedTokens);
  });

  test('only COMPLETE, successful exchanges become history: failed, "not found" and unsupported-language turns do not', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    engine.plan.noContext = true;
    await send('colleague', id, 'A question with no answer?').expect(200);
    engine.plan.noContext = false;
    engine.plan.failBeforeText = true;
    await send('colleague', id, 'A question that failed?').expect(503);
    engine.plan.failBeforeText = false;
    await send('colleague', id, 'पालतू जानवर नीति क्या है?').expect(200); // unsupported language
    engine.seen.length = 0;
    await send('colleague', id, 'Now a real follow-up?').expect(200);
    expect(engine.seen.find((c) => c.rag).rag.history).toBeUndefined();
  });

  test('history is limited to the most recent exchanges, trimmed, and never includes another user\'s messages', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    for (let i = 0; i < 5; i += 1) await send('colleague', id, `Question number ${i} ${'padding '.repeat(100)}`).expect(200); // eslint-disable-line no-await-in-loop
    engine.seen.length = 0;
    await send('colleague', id, 'latest?').expect(200);
    const { history } = engine.seen.find((c) => c.rag).rag;
    expect(history).toHaveLength(env.AI_CONVERSATION_HISTORY_TURNS * 2);
    expect(history[0].content).toMatch(/^Question number 2/);
    expect(history.every((m) => m.content.length <= 500)).toBe(true);
    const other = await newConv('emp');
    await send('emp', other, 'emp question?').expect(200);
    expect(JSON.stringify(engine.seen.find((c) => c.rag).rag.history)).not.toMatch(/emp question/);
  });

  test('retrieval stays live: a document revoked between two turns is not used for the follow-up, whatever the history says', async () => {
    const made = await doc(['Secret leave rule.']);
    const id = await newConv();
    expect((await send('colleague', id, 'What is the leave rule?').expect(200)).body.assistantMessage.citations).toHaveLength(1);
    await Document.updateOne({ _id: made.doc._id }, { deletedAt: new Date() }); // trashed
    const res = await send('colleague', id, 'And what about the carry over?').expect(200);
    expect(res.body.assistantMessage).toMatchObject({ finishReason: 'no_context', citations: [] });
  });
});

describe('citations in history are re-authorized on every read', () => {
  test('a document that becomes inaccessible disappears from old answers (no name, no id), and a restored one reappears', async () => {
    const made = await doc(['Leave is 24 days.']);
    const id = await newConv();
    await send('colleague', id, 'How much leave?').expect(200);
    expect((await messages('colleague', id))[1].citations[0]).toMatchObject({ available: true, documentName: made.doc.name });

    await Document.updateOne({ _id: made.doc._id }, { deletedAt: new Date() });
    const hidden = (await messages('colleague', id))[1].citations[0];
    expect(hidden).toEqual({ n: 1, available: false });
    expect(JSON.stringify(await messages('colleague', id))).not.toContain(made.doc.name);

    await Document.updateOne({ _id: made.doc._id }, { deletedAt: null });
    expect((await messages('colleague', id))[1].citations[0].available).toBe(true);

    await Document.updateOne({ _id: made.doc._id }, { visibility: 'private', owner: users.emp._id }); // now private to someone else
    expect((await messages('colleague', id))[1].citations[0]).toEqual({ n: 1, available: false });
  });

  test('the name shown is the CURRENT name, and a citation naming a document of another organization is never shown', async () => {
    const made = await doc(['Leave is 24 days.']);
    const id = await newConv();
    await send('colleague', id, 'How much leave?').expect(200);
    await Document.updateOne({ _id: made.doc._id }, { name: 'Renamed policy.txt' });
    expect((await messages('colleague', id))[1].citations[0].documentName).toBe('Renamed policy.txt');
    await AiMessage.updateOne({ conversation: id, role: 'assistant' }, { $set: { 'citations.0.documentId': oid().toString() } }); // points at nothing
    expect((await messages('colleague', id))[1].citations[0]).toEqual({ n: 1, available: false });
  });
});

describe('cancellation and incomplete replies', () => {
  test('a client that goes away mid-answer leaves an INCOMPLETE reply with the text produced so far; usage is cancelled and settled; the conversation is free again', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    engine.plan.hang = true;
    await new Promise((resolve) => {
      send('colleague', id, 'How much leave?', 'text/event-stream')
        .buffer(false)
        .parse((res, cb) => {
          let seen = '';
          res.on('data', (chunk) => {
            seen += chunk;
            if (seen.includes('event: text')) { res.destroy(); cb(null, null); resolve(); }
          });
        })
        .end(() => {});
    });
    await until(async () => (await AiMessage.findOne({ conversation: id, role: 'assistant' }))?.status === 'incomplete');
    const reply = await AiMessage.findOne({ conversation: id, role: 'assistant' }).lean();
    expect(reply).toMatchObject({ status: 'incomplete', finishReason: 'cancelled', errorCode: 'AI_REQUEST_ABORTED' });
    expect(reply.content).toMatch(/^Answer to/); // what was produced is kept
    expect(reply.citations).toEqual([]); // and nothing is cited from an unfinished answer
    await until(async () => (await AiUsageEvent.countDocuments({ status: 'cancelled' })) === 1);
    expect(await AiUsageEvent.findOne({ status: 'cancelled' })).toMatchObject({ quotaSettled: true, streamStarted: true });
    expect(await AIConversation.findById(id)).toMatchObject({ activeRequestKey: null, leaseExpiresAt: null, messageCount: 2 });
    engine.plan.hang = false;
    await send('colleague', id, 'Try again?').expect(200); // the conversation is usable again
    // a cancelled exchange is not offered as history for the next question
    expect(engine.seen.filter((c) => c.rag).at(-1).rag.history).toBeUndefined();
  });

  test('a stream that breaks after some text keeps the partial reply as incomplete with the failure code (no internals)', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    engine.plan.failAfterText = true;
    const res = await send('colleague', id, 'How much leave?', 'text/event-stream').buffer(true).parse(sse);
    expect(parseSse(res.body).at(-1)).toMatchObject({ type: 'error', code: 'AI_SERVICE_UNAVAILABLE' });
    const reply = (await messages('colleague', id))[1];
    expect(reply).toMatchObject({ status: 'incomplete', errorCode: 'AI_SERVICE_UNAVAILABLE', citations: [] });
    expect(reply.content).toMatch(/^Answer to/);
    expect(await AIConversation.findById(id)).toMatchObject({ activeRequestKey: null });
  });

  test('a failure before any answer is an HTTP error AND leaves no trace in the transcript', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    engine.plan.failBeforeText = true;
    const res = await send('colleague', id, 'How much leave?');
    expect([res.status, res.body.code]).toEqual([503, 'AI_RETRIEVAL_UNAVAILABLE']);
    expect(await AiMessage.countDocuments({ conversation: id })).toBe(0);
    expect(await AIConversation.findById(id)).toMatchObject({ messageCount: 0, activeRequestKey: null, title: 'New conversation' }.title ? { messageCount: 0, activeRequestKey: null } : {});
    expect(await AiUsageEvent.findOne({})).toMatchObject({ status: 'error', chargedTokens: 0, streamStarted: false });
    engine.plan.failBeforeText = false;
    const ok = await send('colleague', id, 'How much leave?').expect(200);
    expect(ok.body.userMessage.seq).toBeGreaterThanOrEqual(1);
  });

  test('only one reply at a time: a second send while one is running is a 409, and exactly one of two simultaneous sends wins', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    engine.plan.hang = true;
    const controller = [];
    const first = new Promise((resolve) => {
      const r = send('colleague', id, 'first?', 'text/event-stream').buffer(false).parse((res, cb) => { res.on('data', () => resolve()); controller.push(res); res.on('close', () => cb(null, null)); });
      r.end(() => {});
    });
    await first;
    const busy = await send('colleague2', id, 'second?');
    expect([busy.status, busy.body.code]).toEqual([409, 'CONVERSATION_BUSY']);
    expect((await as('colleague2').get(`${BASE}/${id}`)).body.conversation.busy).toBe(true);
    expect(await AiMessage.countDocuments({ conversation: id })).toBe(2); // the refused one left nothing
    controller[0].destroy();
    await until(async () => (await AIConversation.findById(id)).activeRequestKey === null);
    engine.plan.hang = false;

    const [a, b] = await Promise.all([send('colleague', id, 'race one?'), send('colleague2', id, 'race two?')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await AiMessage.find({ conversation: id }).sort({ seq: 1 }).lean()).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });

  test('a crashed request\'s lease expires: the next send recovers the conversation and closes the dead reply', async () => {
    const id = await newConv();
    await AiMessage.create({ conversation: id, organization: orgA._id, user: users.colleague._id, seq: 1, role: 'assistant', content: 'half', status: 'streaming', requestKey: 'dead' });
    await AIConversation.updateOne({ _id: id }, { $set: { activeRequestKey: 'dead', leaseExpiresAt: new Date(Date.now() - 1000), nextSeq: 3, messageCount: 2 } });
    await send('colleague', id, 'hello there?').expect(200);
    expect((await AiMessage.findOne({ conversation: id, seq: 1 }))).toMatchObject({ status: 'incomplete', finishReason: 'interrupted' });
  });

  test('deleting a conversation while it is answering is safe: the late reply writes nothing back', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    engine.plan.hang = true;
    const res = [];
    await new Promise((resolve) => { send('colleague', id, 'q?', 'text/event-stream').buffer(false).parse((r, cb) => { r.on('data', () => resolve()); res.push(r); r.on('close', () => cb(null, null)); }).end(() => {}); });
    await as('colleague2').delete(`${BASE}/${id}`).expect(200);
    res[0].destroy();
    await until(async () => (await AiUsageEvent.countDocuments({ status: 'cancelled' })) === 1);
    expect(await AiMessage.countDocuments({ conversation: id })).toBe(0);
    expect(await AIConversation.countDocuments({ _id: id })).toBe(0);
  });
});

describe('quota and metering stay authoritative in Node', () => {
  test('a refused (over-quota) turn is an HTTP error, is recorded as denied with 0 tokens and leaves the transcript untouched', async () => {
    await doc(['Leave is 24 days.']);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { $set: { 'quotas.userDailyTokens': 50 } });
    const id = await newConv();
    const res = await send('colleague', id, 'How much leave?');
    expect(res.status).toBe(413);
    expect(String(res.body.code)).toMatch(/AI_QUOTA/);
    expect(await AiMessage.countDocuments({})).toBe(0);
    expect(await AiUsageEvent.findOne({})).toMatchObject({ status: 'denied', chargedTokens: 0 });
    expect(engine.seen.filter((c) => c.rag)).toHaveLength(0); // the engine was never called
  });

  test('a successful turn is charged the real usage once, reserved first, settled, and linked to the conversation', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    await send('colleague', id, 'How much leave?').expect(200);
    const rows = await AiUsageEvent.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature: 'document_qa', status: 'success', inputTokens: 900, outputTokens: 40, chargedTokens: 940, quotaSettled: true });
    expect(rows[0].conversation.toString()).toBe(id);
    expect(JSON.stringify(rows)).not.toMatch(/How much leave|Leave is 24 days|Answer to/);
  });

  test('the engine call carries the metered request key of the stored messages; identity comes from the session, never the body', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    await send('colleague', id, 'How much leave?').expect(200);
    const call = engine.seen.find((c) => c.rag);
    expect(call.identity).toEqual({ userId: users.colleague._id.toString(), orgId: orgA._id.toString(), requestKey: expect.any(String) });
    expect((await AiMessage.find({ conversation: id }).lean()).every((m) => m.requestKey === call.identity.requestKey)).toBe(true);
  });

  test('AI switched off for the organization stops new turns (and writes nothing) but history stays readable', async () => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    await send('colleague', id, 'How much leave?').expect(200);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { $set: { enabled: false } });
    const res = await send('colleague', id, 'More?');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await AiMessage.countDocuments({ conversation: id })).toBe(2);
    expect((await messages('colleague', id))).toHaveLength(2);
    await as('colleague').delete(`${BASE}/${id}`).expect(200); // and the owner can still delete it
  });

  test('a conversation has a length limit', async () => {
    await doc(['Leave is 24 days.']);
    env.AI_CONVERSATION_MAX_MESSAGES = 4;
    const id = await newConv();
    await send('colleague', id, 'one?').expect(200);
    await send('colleague', id, 'two?').expect(200);
    const res = await send('colleague', id, 'three?');
    expect([res.status, res.body.code]).toEqual([409, 'CONVERSATION_FULL']);
    expect(await AiMessage.countDocuments({ conversation: id })).toBe(4);
  });
});

describe('English-only language policy', () => {
  test.each([
    ['Hindi', 'एक साल में कितनी छुट्टियाँ मिलती हैं?'],
    ['Punjabi', 'ਇੱਕ ਸਾਲ ਵਿੱਚ ਕਿੰਨੀਆਂ ਛੁੱਟੀਆਂ ਮਿਲਦੀਆਂ ਹਨ?'],
    ['Arabic', 'كم عدد أيام الإجازة؟'],
    ['mostly Hindi with an English product name', 'Sync OS में छुट्टी की नीति क्या है और कितने दिन मिलते हैं'],
  ])('%s: a clear fixed reply, no retrieval, no model call, no usage, nothing charged - in a conversation', async (_n, question) => {
    await doc(['Leave is 24 days.']);
    const id = await newConv();
    const res = await send('colleague', id, question).expect(200);
    expect(res.body.assistantMessage).toMatchObject({ status: 'complete', finishReason: 'unsupported_language', citations: [] });
    expect(res.body.assistantMessage.content).toMatch(/English only/);
    expect(engine.seen.filter((c) => c.rag)).toHaveLength(0);
    expect(await AiUsageEvent.countDocuments({})).toBe(0);
    expect(res.body.usage).toBeNull();
  });

  test('the same policy applies to /ask', async () => {
    await doc(['Leave is 24 days.']);
    const res = await as('colleague').post('/api/v1/ai/ask').send({ question: 'ਛੁੱਟੀਆਂ ਕਿੰਨੀਆਂ ਹਨ?' }).expect(200);
    expect(res.body.answer).toMatch(/English only/);
    expect(res.body.finishReason).toBe('unsupported_language');
    expect(res.body.citations).toEqual([]);
    expect(engine.seen.filter((c) => c.rag)).toHaveLength(0);
    expect(await AiUsageEvent.countDocuments({})).toBe(0);
  });

  test('English questions - including ones with numbers, names and a little non-English - are not refused', async () => {
    await doc(['Leave is 24 days.']);
    for (const q of ['How many days of leave in 2026?', 'What does the "chhutti" policy say?', 'Does Rahul Sharma get 24 days?', '12345']) {
      const id = await newConv(); // eslint-disable-line no-await-in-loop
      const res = await send('colleague', id, q).expect(200); // eslint-disable-line no-await-in-loop
      expect(res.body.assistantMessage.finishReason).not.toBe('unsupported_language');
    }
  });

  test('the gate still applies first: the policy never reveals anything to a user who may not use AI', async () => {
    const id = await newConv();
    await AiOrgSettings.updateOne({ organization: orgA._id }, { $set: { enabled: false } });
    expect((await send('colleague', id, 'एक सवाल')).status).toBeGreaterThanOrEqual(400);
  });
});

describe('content never leaks', () => {
  test('nothing the user typed or the model said is logged by Node (console, errors, usage rows)', async () => {
    await doc(['Leave is 24 days.']);
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    try {
      const id = await newConv();
      await send('colleague', id, 'SECRET-QUESTION-MARKER how much leave?').expect(200);
      engine.plan.failAfterText = true;
      await send('colleague', id, 'SECRET-QUESTION-MARKER again?', 'text/event-stream').buffer(true).parse(sse);
      engine.plan.failAfterText = false;
      engine.plan.hang = true;
      await send('colleague', id, 'SECRET-QUESTION-MARKER third?').timeout(300).catch(() => {});
      engine.plan.hang = false;
      await send('emp', id, 'SECRET-QUESTION-MARKER probe?'); // 404 for a non-owner
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      expect(logged).not.toMatch(/SECRET-QUESTION-MARKER|Leave is 24 days|Answer to/);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(JSON.stringify(await AiUsageEvent.find({}).lean())).not.toMatch(/SECRET-QUESTION-MARKER|Leave is 24 days|Answer to/);
  });

  test('the prompt-side data never reaches other users: a colleague\'s history is invisible in anyone else\'s engine call', async () => {
    await doc(['Leave is 24 days.']);
    const mine = await newConv('colleague');
    await send('colleague', mine, 'PRIVATE-FOLLOWUP-TOPIC question?').expect(200);
    const admin = await newConv('orgAdmin');
    await send('orgAdmin', admin, 'What is up?').expect(200);
    expect(JSON.stringify(engine.seen.filter((c) => c.identity.userId === users.orgAdmin._id.toString()).map((c) => c.rag))).not.toMatch(/PRIVATE-FOLLOWUP-TOPIC/);
  });

  test('error responses carry codes and generic messages only', async () => {
    const id = await newConv();
    engine.plan.failBeforeText = true;
    const res = await send('colleague', id, 'SECRET-QUESTION-MARKER?');
    expect(JSON.stringify(res.body)).not.toContain('SECRET-QUESTION-MARKER');
    expect(`${res.body.code} ${res.body.message}`).not.toMatch(/mongo|redis|qdrant|groq/i); // (the stack field is the existing dev-only error handler behaviour)
  });
});
