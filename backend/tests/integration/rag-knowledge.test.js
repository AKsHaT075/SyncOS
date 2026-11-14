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
 * Node is the AUTHORITY on which retrieved chunks may reach the model. This suite drives the real service and the real
 * internal endpoint against MongoDB, the real document access rules, and the real callback gate.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const env = require('../../src/config/env');
const { connectTestDb, disconnectTestDb } = require('../helpers/db');
const { createHarness } = require('../helpers/harness');
const { addVersion, createIndexedDocument, ensureIndexes } = require('../helpers/ingestionHelpers');
const { createKeyPair, createStubAiService } = require('../helpers/stubAiService');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { ROLES } = require('../../src/constants/roles');
const { describeSpace } = require('../../src/constants/embedding.constants');
const AiEmbeddingConfig = require('../../src/models/AiEmbeddingConfig');
const AiOrgSettings = require('../../src/models/AiOrgSettings');
const Document = require('../../src/models/Document');
const DocumentChunk = require('../../src/models/DocumentChunk');
const DocumentIngestionJob = require('../../src/models/DocumentIngestionJob');
const DocumentVersion = require('../../src/models/DocumentVersion');
const EmbeddingJob = require('../../src/models/EmbeddingJob');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const hub = require('../../src/services/notificationHub');
const aiService = require('../../src/services/ai/aiService');
const tokens = require('../../src/services/ai/aiService/tokens');
const limits = require('../../src/services/ai/aiLimits.service');
const knowledge = require('../../src/services/ai/rag/knowledgeAccess.service');
const { createInternalApp } = require('../../src/internalApp');

const { users, createUser } = createHarness();
const pair = createKeyPair();
const stub = createStubAiService({ publicKey: pair.publicKey });
const internal = createInternalApp();
const oid = () => new mongoose.Types.ObjectId();
const E5 = describeSpace('multilingual-e5-small');
const redis = () => createRedisClient();
const saved = {};
let orgA; let orgB; let team; let project;

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** A document in `org` visible as `visibility`, extracted AND embedded in the active space, with the given chunk texts. */
async function indexed({ org = orgA, owner = users.ownerA, visibility = 'organization', texts = ['chunk zero text', 'chunk one text'], space = E5.id, extra = {} } = {}) {
  const made = await createIndexedDocument({ organization: org, owner, texts, visibility, ...extra });
  if (extra.team || visibility === 'team') await Document.updateOne({ _id: made.doc._id }, { team: extra.team || team._id });
  if (visibility === 'project') await Document.updateOne({ _id: made.doc._id }, { project: extra.project || project._id });
  await EmbeddingJob.create({ organization: org._id, document: made.doc._id, kind: 'embed', version: 1, ingestionPipeline: 'p2', spaceId: space, status: 'completed', chunkCount: texts.length, digest: 'd'.repeat(64) });
  return made;
}
const cand = (doc, i = 0, chunks, over = {}) => ({ documentId: doc._id.toString(), version: 1, chunkIndex: i, textHash: sha(chunks[i].text), ...over });
const asked = async (actor, made, indexes = [0]) => knowledge.authorizeChunks({ actor: await User.findById(actor._id), candidates: indexes.map((i) => cand(made.doc, i, made.chunks)) });
const docIds = (r) => r.items.map((i) => `${i.documentId}:${i.chunkIndex}`);

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  await ensureIndexes();
  await Promise.all(['ownerA', 'colleagueA', 'adminA', 'guestA'].map(() => null));
  await stub.start();
  for (const k of ['AI_SERVICE_URL', 'AI_SERVICE_SIGNING_KEY', 'AI_EMBEDDING_SPACE']) saved[k] = env[k];
  aiService.resetEngine();
});
afterAll(async () => {
  Object.assign(env, saved);
  await stub.stop();
  await hub.shutdown();
  const found = await redis().keys('test:ai:*');
  if (found.length) await redis().del(found);
  await disconnectTestDb();
  await redis().quit();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  stub.reset();
  env.AI_SERVICE_URL = stub.url;
  env.AI_SERVICE_SIGNING_KEY = pair.privateKey;
  env.AI_GLOBAL_ENABLED = true;
  env.AI_EMBEDDING_SPACE = 'multilingual-e5-small';
  env.AI_RATE_LIMIT_PER_MINUTE = 1000;
  env.AI_MAX_CONCURRENT_PER_USER = 50;
  await Promise.all([AiEmbeddingConfig, AiOrgSettings, Document, DocumentChunk, DocumentIngestionJob, DocumentVersion, EmbeddingJob, Organization, Project, Team, User].map((m) => m.deleteMany({})));
  const found = await redis().keys('test:ai:*');
  if (found.length) await redis().del(found);
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: oid() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: oid() });
  await createUser(orgA, 'ownerA', ROLES.EMPLOYEE);
  await createUser(orgA, 'colleagueA', ROLES.EMPLOYEE);
  await createUser(orgA, 'adminA', ROLES.ORG_ADMIN);
  await createUser(orgA, 'hrA', ROLES.HR);
  await createUser(orgA, 'guestA', ROLES.GUEST);
  await createUser(orgB, 'userB', ROLES.EMPLOYEE);
  team = await Team.create({ name: 'Platform', organization: orgA._id, createdBy: users.adminA._id, lead: users.ownerA._id, members: [users.ownerA._id] });
  project = await Project.create({ name: 'Apollo', slug: 'apollo', organization: orgA._id, owner: users.ownerA._id, members: [{ user: users.ownerA._id, role: 'Contributor' }], createdBy: users.ownerA._id });
  await AiOrgSettings.create([{ organization: orgA._id, enabled: true }, { organization: orgB._id, enabled: true }]);
  await AiEmbeddingConfig.create({ _id: 'embedding', activeSpaceId: E5.id, spaces: { [E5.id]: E5.descriptor } });
});

describe('visibility rules applied live to retrieved chunks', () => {
  test('an organization-wide document is available to every member who can see it, with name, version, chunk id and location', async () => {
    const made = await indexed({ texts: ['Leave is 24 days per year.', 'Carry over 5 days.'] });
    const r = await asked(users.colleagueA, made, [0, 1]);
    expect(r.items).toHaveLength(2);
    const first = r.items[0];
    expect(first).toMatchObject({ documentId: made.doc._id.toString(), version: 1, chunkIndex: 0, textHash: sha('Leave is 24 days per year.'), text: 'Leave is 24 days per year.', documentName: made.doc.name, location: { charStart: 0, charEnd: 9 } });
    expect(first.chunkId).toBe((await DocumentChunk.findOne({ document: made.doc._id, chunkIndex: 0 }))._id.toString());
    expect(first.location._id).toBeUndefined();
  });

  test('PRIVATE documents are owner-only: not other employees, not admins, not even people it was shared with', async () => {
    const made = await indexed({ visibility: 'private', owner: users.ownerA, texts: ['Salary bands are confidential.'] });
    await Document.updateOne({ _id: made.doc._id }, { sharedWith: [{ user: users.colleagueA._id, permission: 'viewer', sharedBy: users.ownerA._id }] });
    expect(docIds(await asked(users.ownerA, made))).toHaveLength(1);
    for (const who of [users.colleagueA, users.adminA, users.hrA]) expect((await asked(who, made)).items).toEqual([]);
  });

  test('team documents follow CURRENT team membership: removing someone revokes access on the very next request', async () => {
    const made = await indexed({ visibility: 'team', texts: ['Team runbook.'] });
    await Team.updateOne({ _id: team._id }, { $addToSet: { members: users.colleagueA._id } });
    expect((await asked(users.colleagueA, made)).items).toHaveLength(1);
    await Team.updateOne({ _id: team._id }, { $pull: { members: users.colleagueA._id } });
    expect((await asked(users.colleagueA, made)).items).toEqual([]);
    expect((await asked(users.ownerA, made)).items).toHaveLength(1); // a member still sees it
  });

  test('project documents follow real project membership', async () => {
    const made = await indexed({ visibility: 'project', texts: ['Project plan.'] });
    expect((await asked(users.colleagueA, made)).items).toEqual([]);
    await Project.updateOne({ _id: project._id }, { $push: { members: { user: users.colleagueA._id, role: 'Contributor' } } });
    expect((await asked(users.colleagueA, made)).items).toHaveLength(1);
  });

  test('admins see team/project/organization documents but still not private ones', async () => {
    const orgWide = await indexed({ texts: ['Open policy.'] });
    const teamDoc = await indexed({ visibility: 'team', texts: ['Team doc.'] });
    expect((await asked(users.adminA, orgWide)).items).toHaveLength(1);
    expect((await asked(users.adminA, teamDoc)).items).toHaveLength(1);
  });

  test('another organization cannot reach the chunks at all, even with exact identifiers', async () => {
    const made = await indexed({ texts: ['Acme only.'] });
    expect((await asked(users.userB, made)).items).toEqual([]);
    const theirs = await indexed({ org: orgB, owner: users.userB, texts: ['Globex only.'] });
    expect((await asked(users.ownerA, theirs)).items).toEqual([]);
  });
});

describe('lifecycle and staleness: only the CURRENT, extracted, embedded version', () => {
  test('trashed documents are rejected', async () => {
    const made = await indexed();
    await Document.updateOne({ _id: made.doc._id }, { deletedAt: new Date() });
    expect((await asked(users.colleagueA, made)).items).toEqual([]);
  });

  test('permanently deleted documents are rejected', async () => {
    const made = await indexed();
    await Document.deleteOne({ _id: made.doc._id });
    expect((await asked(users.colleagueA, made)).items).toEqual([]);
  });

  test('stale versions are rejected: after a new version, v1 chunks are refused even though their vectors still exist', async () => {
    const made = await indexed({ texts: ['Notice period is 60 days.'] });
    await addVersion(made.doc, Buffer.from('v2'));
    expect((await asked(users.colleagueA, made)).items).toEqual([]);
    const v2 = await Document.findById(made.doc._id);
    await createIndexedDocument({ organization: orgA, owner: users.ownerA, doc: v2, version: 2, texts: ['Notice period is 30 days.'] });
    await EmbeddingJob.create({ organization: orgA._id, document: v2._id, kind: 'embed', version: 2, ingestionPipeline: 'p2', spaceId: E5.id, status: 'completed', chunkCount: 1, digest: 'd'.repeat(64) });
    const r = await knowledge.authorizeChunks({ actor: await User.findById(users.colleagueA._id), candidates: [{ documentId: v2._id.toString(), version: 2, chunkIndex: 0, textHash: sha('Notice period is 30 days.') }, { documentId: v2._id.toString(), version: 1, chunkIndex: 0, textHash: sha('Notice period is 60 days.') }] });
    expect(r.items.map((i) => [i.version, i.text])).toEqual([[2, 'Notice period is 30 days.']]);
  });

  test('a chunk whose text changed since its vector was made is rejected (hash mismatch)', async () => {
    const made = await indexed({ texts: ['Original text.'] });
    await DocumentChunk.updateOne({ document: made.doc._id, chunkIndex: 0 }, { text: 'Edited text.', textHash: sha('Edited text.') });
    expect((await asked(users.colleagueA, made)).items).toEqual([]);
  });

  test.each([
    ['extraction not indexed', async (m) => DocumentIngestionJob.updateOne({ document: m.doc._id }, { status: 'failed' })],
    ['embedding not completed', async (m) => EmbeddingJob.updateOne({ document: m.doc._id }, { status: 'failed' })],
    ['embedded only in a different (not active) space', async (m) => EmbeddingJob.updateOne({ document: m.doc._id }, { spaceId: describeSpace('fake-hash-384').id })],
    ['chunks from another ingestion pipeline', async (m) => DocumentChunk.updateMany({ document: m.doc._id }, { pipelineVersion: 'p1' })],
    ['the chunk row is gone', async (m) => DocumentChunk.deleteMany({ document: m.doc._id })],
  ])('not usable: %s', async (_n, mutate) => {
    const made = await indexed();
    await mutate(made);
    expect((await asked(users.colleagueA, made)).items).toEqual([]);
  });

  test('no active embedding space => nothing is released', async () => {
    const made = await indexed();
    await AiEmbeddingConfig.updateOne({ _id: 'embedding' }, { activeSpaceId: null, targetSpaceId: E5.id });
    expect((await asked(users.colleagueA, made)).items).toEqual([]);
  });
});

describe('malformed or hostile candidate lists', () => {
  test('invalid ids, versions, indexes and hashes are dropped without error; duplicates collapse', async () => {
    const made = await indexed({ texts: ['Valid chunk.'] });
    const good = cand(made.doc, 0, made.chunks);
    const r = await knowledge.authorizeChunks({
      actor: await User.findById(users.colleagueA._id),
      candidates: [good, good, { ...good, documentId: 'not-an-id' }, { ...good, version: 1.5 }, { ...good, chunkIndex: -1 }, { ...good, textHash: 7 }, { ...good, chunkIndex: 99 }, { ...good, documentId: oid().toString() }],
    });
    expect(r.items).toHaveLength(1);
    expect(r.rejected).toBe(7);
  });

  test('the response never says WHY something was refused, only how many', async () => {
    const hidden = await indexed({ visibility: 'private', owner: users.ownerA, texts: ['Hidden.'] });
    const r = await asked(users.colleagueA, hidden);
    expect(Object.keys(r).sort()).toEqual(['items', 'rejected']);
    expect(JSON.stringify(r)).not.toMatch(/private|forbidden|denied|trash/i);
  });

  test('the total text released per call is capped', async () => {
    const big = 'w '.repeat(3900);
    const many = await indexed({ texts: Array.from({ length: 50 }, (_, i) => `${big}${i}`) });
    const r = await knowledge.authorizeChunks({ actor: await User.findById(users.colleagueA._id), candidates: many.chunks.map((c, i) => cand(many.doc, i, many.chunks)) });
    expect(r.items.reduce((n, i) => n + i.text.length, 0)).toBeLessThanOrEqual(150000);
  });
});

describe('the internal endpoint: only a live callback token for THIS request, scoped to knowledge', () => {
  const post = (token, body) => {
    const req = request(internal).post('/internal/ai/knowledge/authorize').send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  /** Starts a REAL request through the pipeline so the request is genuinely in flight; returns its callback token. */
  async function inFlight(actor) {
    const { streamAiRequest } = require('../../src/services/ai/aiPipeline.service');
    stub.enqueue({ frames: [{ type: 'text', text: 'hi' }], hangAfterFrames: true });
    const controller = new AbortController();
    const requestKey = crypto.randomUUID();
    const run = (async () => {
      try {
        for await (const e of streamAiRequest({ actor, feature: 'document_qa', messages: [{ role: 'user', content: 'q' }], signal: controller.signal, requestKey })) void e;
      } catch { /* aborted at the end */ }
    })();
    const before = stub.requests.length;
    const end = Date.now() + 5000;
    while (stub.requests.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 15)); // eslint-disable-line no-await-in-loop
    return {
      requestKey,
      token: tokens.signCallbackToken({ userId: actor._id.toString(), orgId: actor.organization.toString(), requestKey, scopes: [tokens.CALLBACK_SCOPES.KNOWLEDGE_AUTHORIZE] }),
      finish: async () => { controller.abort(); await run; },
    };
  }

  test('released text comes back with the exact fields Python needs, and the authorized ids are remembered for the citation check', async () => {
    const made = await indexed({ texts: ['Leave is 24 days.'] });
    const live = await inFlight(users.colleagueA);
    const res = await post(live.token, { candidates: [cand(made.doc, 0, made.chunks)] }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ success: true, rejected: 0, items: [{ text: 'Leave is 24 days.', documentName: made.doc.name, version: 1, chunkIndex: 0 }] });
    const chunkId = res.body.items[0].chunkId;
    const confirmed = await knowledge.confirmCitations(live.requestKey, [{ chunkId }, { chunkId: oid().toString() }]);
    expect(confirmed).toEqual({ citations: [{ chunkId }], dropped: 1 }); // a chunk Node did not authorize cannot be cited
    await live.finish();
  });

  test.each([
    ['no token', () => null],
    ['garbage', () => 'not.a.jwt'],
    ['a plain tool-scope callback token', async () => null],
  ])('refused: %s', async (_n, mk) => {
    const made = await indexed();
    const live = await inFlight(users.colleagueA);
    const token = (await mk()) ?? tokens.signCallbackToken({ userId: users.colleagueA._id.toString(), orgId: orgA._id.toString(), requestKey: live.requestKey, scopes: [tokens.CALLBACK_SCOPES.TOOL_EXECUTE] });
    const res = await post(token, { candidates: [cand(made.doc, 0, made.chunks)] });
    expect([401, 403]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain(made.chunks[0].text);
    await live.finish();
  });

  test('a generate token (wrong audience) cannot be used here', async () => {
    const made = await indexed();
    const generate = tokens.signGenerateToken({ userId: users.colleagueA._id.toString(), orgId: orgA._id.toString(), requestKey: crypto.randomUUID(), maxOutputTokens: 10 });
    expect((await post(generate, { candidates: [cand(made.doc, 0, made.chunks)] })).status).toBe(401);
  });

  test('once the request has finished, its token is dead (no text can be fetched afterwards)', async () => {
    const made = await indexed();
    const live = await inFlight(users.colleagueA);
    await post(live.token, { candidates: [cand(made.doc, 0, made.chunks)] }).expect(200);
    await live.finish();
    await new Promise((r) => setTimeout(r, 100));
    expect((await post(live.token, { candidates: [cand(made.doc, 0, made.chunks)] })).status).toBe(401);
  });

  test('blocking the user mid-request, switching AI off, or the kill switch each stop the release immediately', async () => {
    const made = await indexed();
    const live = await inFlight(users.colleagueA);
    const body = { candidates: [cand(made.doc, 0, made.chunks)] };
    await post(live.token, body).expect(200);
    await User.updateOne({ _id: users.colleagueA._id }, { orgBlocked: true });
    expect((await post(live.token, body)).status).toBe(401);
    await User.updateOne({ _id: users.colleagueA._id }, { orgBlocked: false });
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: false });
    expect((await post(live.token, body)).status).toBe(403);
    await AiOrgSettings.updateOne({ organization: orgA._id }, { enabled: true });
    env.AI_GLOBAL_ENABLED = false;
    expect((await post(live.token, body)).status).toBe(403);
    env.AI_GLOBAL_ENABLED = true;
    await post(live.token, body).expect(200);
    await live.finish();
  });

  test('permissions are those of the token\'s user: a role change takes effect on the next call', async () => {
    const made = await indexed({ visibility: 'private', owner: users.ownerA, texts: ['Mine.'] });
    const live = await inFlight(users.ownerA);
    expect((await post(live.token, { candidates: [cand(made.doc, 0, made.chunks)] }).expect(200)).body.items).toHaveLength(1);
    await User.updateOne({ _id: users.ownerA._id }, { role: ROLES.GUEST }); // guests have no AI at all
    expect((await post(live.token, { candidates: [cand(made.doc, 0, made.chunks)] })).status).toBe(403);
    await live.finish();
  });

  test('the body is strict: unknown fields (identity!) and bad shapes are rejected', async () => {
    const made = await indexed();
    const live = await inFlight(users.colleagueA);
    const c = cand(made.doc, 0, made.chunks);
    for (const bad of [{ candidates: [c], user: users.adminA._id.toString() }, { candidates: [c], organization: orgB._id.toString() }, { candidates: [] }, { candidates: Array.from({ length: 51 }, () => c) }, { candidates: [{ ...c, extra: 1 }] }, { candidates: [{ ...c, documentId: 'x' }] }, {}]) {
      expect((await post(live.token, bad)).status).toBe(400); // eslint-disable-line no-await-in-loop
    }
    await live.finish();
  });

  test('released text is never logged', async () => {
    const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const made = await indexed({ texts: ['SECRET-BOARD-TEXT about layoffs.'] });
    const live = await inFlight(users.colleagueA);
    await post(live.token, { candidates: [cand(made.doc, 0, made.chunks)] }).expect(200);
    await post('garbage', { candidates: [cand(made.doc, 0, made.chunks)] });
    await live.finish();
    expect(spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n')).not.toContain('SECRET-BOARD-TEXT');
  });
});
