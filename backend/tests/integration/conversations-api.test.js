jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});
jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn(), sendInvitationEmail: jest.fn(),
  sendMeetingInvitationEmail: jest.fn(), sendMeetingRequestDecisionEmail: jest.fn(),
}));

/** Conversation management: ownership, isolation, pagination, rename / archive / delete, retention. No model involved. */
const mongoose = require('mongoose');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { ensureIndexes } = require('../helpers/ingestionHelpers');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const AIConversation = require('../../src/models/AIConversation');
const AiMessage = require('../../src/models/AiMessage');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const Organization = require('../../src/models/Organization');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const retention = require('../../src/services/ai/conversations/conversationRetention.service');
const aiService = require('../../src/services/ai/aiService');
const { createInternalApp } = require('../../src/internalApp');
const { createKeyPair } = require('../helpers/stubAiService');
const { createRagEngine } = require('../helpers/ragEngine');

const { users, createUser, makeAgent, as } = createHarness();
const oid = () => new mongoose.Types.ObjectId();
const pair = createKeyPair();
const savedKey = env.AI_SERVICE_SIGNING_KEY;
const KEYS = ['emp', 'colleague', 'orgAdmin', 'hr', 'manager', 'guest', 'superadmin', 'empB', 'adminB'];
let orgA; let orgB;
const BASE = '/api/v1/ai/conversations';
const DAY = 24 * 60 * 60 * 1000;

const create = async (key, title) => (await as(key).post(BASE).send(title ? { title } : {}).expect(201)).body.conversation;
async function seed(conversation, owner, turns = 1) {
  const rows = [];
  for (let i = 0; i < turns; i += 1) {
    const seq = i * 2 + 1;
    rows.push({ conversation, organization: owner.organization, user: owner._id, seq, role: 'user', content: `PRIVATE-QUESTION-${i}`, status: 'complete' });
    rows.push({ conversation, organization: owner.organization, user: owner._id, seq: seq + 1, role: 'assistant', content: `PRIVATE-ANSWER-${i}`, status: 'complete', finishReason: 'stop' });
  }
  await AiMessage.insertMany(rows);
  await AIConversation.updateOne({ _id: conversation }, { $set: { messageCount: rows.length, nextSeq: rows.length + 1 } });
}

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await ensureIndexes();
  await AIConversation.init();
  await AiMessage.init();
  await Promise.all(KEYS.map(makeAgent));
  env.AI_SERVICE_SIGNING_KEY = pair.privateKey;
  aiService.setEngine(createRagEngine(createInternalApp()));
});
afterAll(async () => {
  env.AI_SERVICE_SIGNING_KEY = savedKey;
  aiService.resetEngine();
  await hub.shutdown();
  await disconnectTestDb();
  await createRedisClient().quit();
});
beforeEach(async () => {
  aiService.invalidateStatus();
  await Promise.all([AIConversation, AiMessage, AiOrgSettings, Organization, User].map((m) => m.deleteMany({})));
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'emp', ROLES.EMPLOYEE);
  await createUser(orgA, 'colleague', ROLES.EMPLOYEE);
  await createUser(orgA, 'orgAdmin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'empB', ROLES.EMPLOYEE);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser({ _id: null, slug: 'platform' }, 'superadmin', ROLES.SUPER_ADMIN, { organization: null });
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true }, { organization: orgB._id, enabled: true }]);
});

describe('ownership and isolation', () => {
  test('every operation on someone else\'s conversation is a 404 - for employees, managers, HR, org admins and other tenants alike', async () => {
    const mine = await create('emp', 'Compensation questions');
    await seed(mine.id, users.emp);
    for (const who of ['colleague', 'manager', 'hr', 'orgAdmin', 'empB', 'adminB']) {
      const attempts = [
        () => as(who).get(`${BASE}/${mine.id}`),
        () => as(who).get(`${BASE}/${mine.id}/messages`),
        () => as(who).patch(`${BASE}/${mine.id}`).send({ title: 'hijack' }),
        () => as(who).patch(`${BASE}/${mine.id}`).send({ archived: true }),
        () => as(who).post(`${BASE}/${mine.id}/messages`).send({ content: 'hello?' }),
        () => as(who).delete(`${BASE}/${mine.id}`),
      ];
      for (const attempt of attempts) {
        // eslint-disable-next-line no-await-in-loop
        const res = await attempt();
        expect({ who, status: res.status, code: res.body.code }).toEqual({ who, status: 404, code: 'CONVERSATION_NOT_FOUND' });
        expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE-|Compensation/);
      }
    }
    // nothing changed
    const intact = await AIConversation.findById(mine.id).lean();
    expect(intact).toMatchObject({ title: 'Compensation questions', status: 'active' });
    expect(await AiMessage.countDocuments({ conversation: mine.id })).toBe(2);
  });

  test('lists are per owner: nobody, admins included, sees another person\'s conversations', async () => {
    await create('emp', 'Emp one');
    await create('colleague', 'Colleague one');
    await create('orgAdmin', 'Admin one');
    await create('empB', 'Other tenant one');
    for (const [who, title] of [['emp', 'Emp one'], ['colleague', 'Colleague one'], ['orgAdmin', 'Admin one'], ['empB', 'Other tenant one']]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await as(who).get(BASE).expect(200);
      expect(res.body.conversations.map((c) => c.title)).toEqual([title]);
    }
  });

  test('malformed, unknown and forged ids are the same 404 as someone else\'s', async () => {
    for (const id of ['not-an-id', oid().toString(), '$ne']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await as('emp').get(`${BASE}/${id}`);
      expect([res.status, res.body.code]).toEqual([404, 'CONVERSATION_NOT_FOUND']);
    }
  });

  test('a body cannot choose the owner or the organization', async () => {
    const res = await as('emp').post(BASE).send({ title: 'x', user: users.colleague._id.toString(), organization: orgB._id.toString() });
    expect(res.status).toBe(400); // strict schema
    const made = await create('emp', 'ok');
    const row = await AIConversation.findById(made.id).lean();
    expect([row.user.toString(), row.organization.toString()]).toEqual([users.emp._id.toString(), orgA._id.toString()]);
  });

  test('guests and the super-admin cannot use conversations at all, and the super-admin reaches no tenant content', async () => {
    const mine = await create('emp', 'Private');
    await seed(mine.id, users.emp);
    for (const who of ['guest', 'superadmin']) {
      for (const call of [() => as(who).get(BASE), () => as(who).post(BASE).send({}), () => as(who).get(`${BASE}/${mine.id}`), () => as(who).get(`${BASE}/${mine.id}/messages`), () => as(who).delete(`${BASE}/${mine.id}`)]) {
        // eslint-disable-next-line no-await-in-loop
        const res = await call();
        expect([403, 404]).toContain(res.status);
        expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE-|Private/);
      }
    }
    expect(await AIConversation.countDocuments({ _id: mine.id })).toBe(1);
  });

  test('the platform has no admin route to read conversations (no route exists beyond the owner\'s own)', async () => {
    for (const path of ['/api/v1/ai/conversations/all', '/api/v1/ai/admin/conversations', '/api/v1/ai/knowledge/conversations']) {
      // eslint-disable-next-line no-await-in-loop
      expect([404, 400]).toContain((await as('orgAdmin').get(path)).status);
    }
  });
});

describe('create, rename, archive, delete', () => {
  test('create gives an untitled active conversation; a custom title is a user title', async () => {
    const a = await create('emp');
    expect(a).toMatchObject({ title: 'New conversation', titleSource: 'auto', status: 'active', messageCount: 0, busy: false });
    const b = await create('emp', '  Leave   questions  ');
    expect(b).toMatchObject({ title: 'Leave questions', titleSource: 'user' });
  });

  test('rename sanitises the title and marks it as the user\'s; an empty or control-only title is refused', async () => {
    const c = await create('emp');
    const res = await as('emp').patch(`${BASE}/${c.id}`).send({ title: 'Plan\u0007 for\n Q3​' }).expect(200);
    expect(res.body.conversation).toMatchObject({ title: 'Plan for Q3', titleSource: 'user' });
    await as('emp').patch(`${BASE}/${c.id}`).send({ title: '\u0007​' }).expect(400);
    await as('emp').patch(`${BASE}/${c.id}`).send({}).expect(400);
    await as('emp').patch(`${BASE}/${c.id}`).send({ title: 'x'.repeat(121) }).expect(400);
    await as('emp').patch(`${BASE}/${c.id}`).send({ title: 'ok', status: 'archived' }).expect(400); // status is only reachable through `archived`
  });

  test('archive hides it from the default list, shows it in the archived list, and restoring brings it back', async () => {
    const c = await create('emp', 'Keep me');
    expect((await as('emp').patch(`${BASE}/${c.id}`).send({ archived: true }).expect(200)).body.conversation).toMatchObject({ status: 'archived' });
    expect((await as('emp').get(BASE).expect(200)).body.conversations).toEqual([]);
    expect((await as('emp').get(`${BASE}?status=archived`).expect(200)).body.conversations.map((x) => x.id)).toEqual([c.id]);
    expect((await as('emp').patch(`${BASE}/${c.id}`).send({ archived: false }).expect(200)).body.conversation).toMatchObject({ status: 'active', archivedAt: null });
    expect((await as('emp').get(BASE).expect(200)).body.conversations).toHaveLength(1);
  });

  test('an archived conversation can still be read but not continued', async () => {
    const c = await create('emp');
    await seed(c.id, users.emp);
    await as('emp').patch(`${BASE}/${c.id}`).send({ archived: true }).expect(200);
    expect((await as('emp').get(`${BASE}/${c.id}/messages`).expect(200)).body.messages).toHaveLength(2);
    const res = await as('emp').post(`${BASE}/${c.id}/messages`).send({ content: 'more?' });
    expect([res.status, res.body.code]).toEqual([409, 'CONVERSATION_ARCHIVED']);
  });

  test('delete removes the conversation and ALL its messages for good; a second delete is a 404', async () => {
    const c = await create('emp');
    await seed(c.id, users.emp, 3);
    const other = await create('emp', 'unrelated');
    await seed(other.id, users.emp, 1);
    await as('emp').delete(`${BASE}/${c.id}`).expect(200);
    expect(await AIConversation.countDocuments({ _id: c.id })).toBe(0);
    expect(await AiMessage.countDocuments({ conversation: c.id })).toBe(0);
    expect(await AiMessage.countDocuments({ conversation: other.id })).toBe(2); // only that conversation's messages
    await as('emp').get(`${BASE}/${c.id}`).expect(404);
    await as('emp').get(`${BASE}/${c.id}/messages`).expect(404);
    await as('emp').delete(`${BASE}/${c.id}`).expect(404);
  });

  test('a per-user cap stops runaway creation', async () => {
    const saved = env.AI_CONVERSATION_MAX_PER_USER;
    env.AI_CONVERSATION_MAX_PER_USER = 2;
    try {
      await create('emp'); await create('emp');
      const res = await as('emp').post(BASE).send({});
      expect([res.status, res.body.code]).toEqual([409, 'CONVERSATION_LIMIT']);
      await create('colleague'); // the cap is per user
    } finally {
      env.AI_CONVERSATION_MAX_PER_USER = saved;
    }
  });
});

describe('pagination', () => {
  test('the conversation list pages newest-activity-first with a cursor: no gaps, no duplicates, stable across ties', async () => {
    const same = new Date();
    const ids = [];
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const c = await create('emp', `Conv ${i}`);
      ids.push(c.id);
    }
    // three share the exact same timestamp: the id breaks the tie
    await AIConversation.updateMany({ _id: { $in: ids.slice(0, 3) } }, { $set: { lastActivityAt: same } });
    await AIConversation.updateMany({ _id: { $in: ids.slice(3) } }, { $set: { lastActivityAt: new Date(same.getTime() + 1000) } });
    const seen = [];
    let cursor;
    for (let guard = 0; guard < 10; guard += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await as('emp').get(`${BASE}?limit=3${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      expect(res.body.conversations.length).toBeLessThanOrEqual(3);
      seen.push(...res.body.conversations.map((c) => c.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen.slice(0, 4))).toEqual(new Set(ids.slice(3))); // the more recent four come first
  });

  test('bad limits and forged cursors are rejected, not trusted', async () => {
    await as('emp').get(`${BASE}?limit=0`).expect(400);
    await as('emp').get(`${BASE}?limit=51`).expect(400);
    await as('emp').get(`${BASE}?status=deleted`).expect(400);
    await as('emp').get(`${BASE}?cursor=!!!`).expect(400);
    const forged = Buffer.from(JSON.stringify({ t: 'not-a-date', id: 'x' })).toString('base64url');
    await as('emp').get(`${BASE}?cursor=${forged}`).expect(400);
  });

  test('messages page BACK in time, each page oldest-to-newest, with no gaps or duplicates', async () => {
    const c = await create('emp');
    await seed(c.id, users.emp, 6); // 12 messages
    const first = (await as('emp').get(`${BASE}/${c.id}/messages?limit=5`).expect(200)).body;
    expect(first.messages.map((m) => m.seq)).toEqual([8, 9, 10, 11, 12]);
    const second = (await as('emp').get(`${BASE}/${c.id}/messages?limit=5&cursor=${first.nextCursor}`).expect(200)).body;
    expect(second.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7]);
    const third = (await as('emp').get(`${BASE}/${c.id}/messages?limit=5&cursor=${second.nextCursor}`).expect(200)).body;
    expect(third.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(third.nextCursor).toBeNull();
    await as('emp').get(`${BASE}/${c.id}/messages?limit=101`).expect(400);
    await as('emp').get(`${BASE}/${c.id}/messages?cursor=${Buffer.from('{"seq":"1; drop"}').toString('base64url')}`).expect(400);
  });

  test('messages are only ever read through the owner\'s scope even if a message row is planted in another conversation', async () => {
    const mine = await create('emp');
    const theirs = await create('colleague');
    await seed(theirs.id, users.colleague);
    // a corrupted row: right conversation id, wrong owner
    await AiMessage.create({ conversation: mine.id, organization: orgA._id, user: users.colleague._id, seq: 1, role: 'user', content: 'PLANTED-ROW', status: 'complete' });
    expect((await as('emp').get(`${BASE}/${mine.id}/messages`).expect(200)).body.messages).toEqual([]);
  });
});

describe('retention and housekeeping', () => {
  const setRetention = (active, archived) => { const s = [env.AI_CONVERSATION_RETENTION_DAYS, env.AI_CONVERSATION_ARCHIVED_RETENTION_DAYS]; env.AI_CONVERSATION_RETENTION_DAYS = active; env.AI_CONVERSATION_ARCHIVED_RETENTION_DAYS = archived; return () => { [env.AI_CONVERSATION_RETENTION_DAYS, env.AI_CONVERSATION_ARCHIVED_RETENTION_DAYS] = s; }; };

  test('inactive conversations and long-archived ones are purged WITH their messages; recent ones are untouched', async () => {
    const restore = setRetention(30, 10);
    try {
      const stale = await create('emp', 'stale'); const fresh = await create('emp', 'fresh'); const oldArchived = await create('emp', 'old archived'); const newArchived = await create('colleague', 'new archived');
      for (const c of [stale, fresh, oldArchived]) await seed(c.id, users.emp);
      await seed(newArchived.id, users.colleague);
      await AIConversation.updateOne({ _id: stale.id }, { $set: { lastActivityAt: new Date(Date.now() - 31 * DAY) } });
      await AIConversation.updateOne({ _id: fresh.id }, { $set: { lastActivityAt: new Date(Date.now() - 5 * DAY) } });
      await AIConversation.updateOne({ _id: oldArchived.id }, { $set: { status: 'archived', archivedAt: new Date(Date.now() - 11 * DAY), lastActivityAt: new Date(Date.now() - 12 * DAY) } });
      await AIConversation.updateOne({ _id: newArchived.id }, { $set: { status: 'archived', archivedAt: new Date(Date.now() - 2 * DAY), lastActivityAt: new Date(Date.now() - 90 * DAY) } }); // archived recently: kept even though inactive for long
      expect(await retention.purgeExpired()).toEqual({ active: 1, archived: 1 });
      expect((await AIConversation.find({}).lean()).map((c) => c.title).sort()).toEqual(['fresh', 'new archived']);
      expect(await AiMessage.countDocuments({ conversation: { $in: [stale.id, oldArchived.id] } })).toBe(0);
      expect(await AiMessage.countDocuments({ conversation: { $in: [fresh.id, newArchived.id] } })).toBe(4);
      expect(await retention.purgeExpired()).toEqual({ active: 0, archived: 0 }); // idempotent
    } finally {
      restore();
    }
  });

  test('0 means "keep forever"', async () => {
    const restore = setRetention(0, 0);
    try {
      const c = await create('emp', 'ancient');
      await AIConversation.updateOne({ _id: c.id }, { $set: { lastActivityAt: new Date(Date.now() - 3000 * DAY) } });
      expect(await retention.purgeExpired()).toEqual({ active: 0, archived: 0 });
      expect(await AIConversation.countDocuments({})).toBe(1);
    } finally {
      restore();
    }
  });

  test('a conversation that is answering right now is not purged', async () => {
    const restore = setRetention(30, 10);
    try {
      const c = await create('emp');
      await AIConversation.updateOne({ _id: c.id }, { $set: { lastActivityAt: new Date(Date.now() - 60 * DAY), activeRequestKey: 'live', leaseExpiresAt: new Date(Date.now() + 60000) } });
      expect((await retention.purgeExpired()).active).toBe(0);
    } finally {
      restore();
    }
  });

  test('a reply whose request died is closed as incomplete and the conversation is freed; a live one is left alone', async () => {
    const dead = await create('emp'); const live = await create('colleague');
    for (const [c, owner, key] of [[dead, users.emp, 'dead-key'], [live, users.colleague, 'live-key']]) {
      await AiMessage.create({ conversation: c.id, organization: owner.organization, user: owner._id, seq: 1, role: 'assistant', content: 'partial', status: 'streaming', requestKey: key });
    }
    await AIConversation.updateOne({ _id: dead.id }, { $set: { activeRequestKey: 'dead-key', leaseExpiresAt: new Date(Date.now() - 1000) } });
    await AIConversation.updateOne({ _id: live.id }, { $set: { activeRequestKey: 'live-key', leaseExpiresAt: new Date(Date.now() + 60000) } });
    expect(await retention.recoverStale()).toBe(1);
    expect(await AiMessage.findOne({ conversation: dead.id })).toMatchObject({ status: 'incomplete', finishReason: 'interrupted', content: 'partial' });
    expect(await AIConversation.findById(dead.id)).toMatchObject({ activeRequestKey: null, leaseExpiresAt: null });
    expect((await AiMessage.findOne({ conversation: live.id })).status).toBe('streaming');
    // even before the sweep runs, a reader never sees a dead reply as "streaming"
    await AIConversation.updateOne({ _id: live.id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    expect((await as('colleague').get(`${BASE}/${live.id}/messages`).expect(200)).body.messages[0]).toMatchObject({ status: 'incomplete' });
  });
});
