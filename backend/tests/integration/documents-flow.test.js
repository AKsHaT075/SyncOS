jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendOtpEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendPasswordResetEmail: jest.fn().mockResolvedValue({ preview: true }),
  sendInvitationEmail: jest.fn().mockResolvedValue({ preview: true }),
}));

// The global API limiter (300 req / 15 min / IP) is not under test here and
// this suite makes more requests than that.
jest.mock('../../src/middlewares/rate-limit.middleware', () => {
  const passthrough = (req, res, next) => next();
  return { apiLimiter: passthrough, authLimiter: passthrough, otpLimiter: passthrough, passwordResetLimiter: passthrough };
});

const fs = require('fs');
const request = require('supertest');
const mongoose = require('mongoose');
const { createApp } = require('../../src/app');
const env = require('../../src/config/env');
const { connectTestDb, clearTestDb, disconnectTestDb } = require('../helpers/db');
const { connectRedis, createRedisClient } = require('../../src/config/redis');
const { signAccessToken } = require('../../src/utils/jwt');
const { ROLES } = require('../../src/constants/roles');
const AuditLog = require('../../src/models/AuditLog');
const Document = require('../../src/models/Document');
const DocumentVersion = require('../../src/models/DocumentVersion');
const Organization = require('../../src/models/Organization');
const Project = require('../../src/models/Project');
const Team = require('../../src/models/Team');
const User = require('../../src/models/User');
const { getStorage } = require('../../src/storage');

const app = createApp();

const agents = {};
const users = {};
let orgA;
let orgB;
let team;
let project;

const pdf = (text = 'hello') => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj\n<<>>\nendobj\n`);

async function createUser(org, key, role) {
  users[key] = await User.create({
    organization: org._id,
    firstName: key,
    lastName: 'Tester',
    email: `${key}@${org.slug}.test`,
    passwordHash: 'x',
    role,
    skills: [],
    isActive: true,
    emailVerified: true,
    hasCreatedOrganization: role === ROLES.ORG_ADMIN,
  });
  return users[key];
}

async function createAgent() {
  const agent = request.agent(app);
  agent.set('Connection', 'close');
  const csrf = await agent.get('/api/v1/auth/csrf-token').expect(200);
  agent.csrfToken = csrf.body.csrfToken;
  return agent;
}

function as(key) {
  const agent = agents[key];
  const user = users[key];
  agent.set(
    'Authorization',
    `Bearer ${signAccessToken({ sub: user._id.toString(), tv: user.tokenVersion, sid: 'test-session' })}`,
  );
  return ['get', 'post', 'put', 'patch', 'delete'].reduce((acc, method) => {
    acc[method] = (path) => agent[method](path).set('x-csrf-token', agent.csrfToken);
    return acc;
  }, {});
}

// Multipart upload helper. `fields` become form fields, `file` the attachment.
function upload(key, { name = 'report.pdf', content = pdf(), type = 'application/pdf', fields = {}, path = '/api/v1/documents' } = {}) {
  let req = as(key).post(path);
  Object.entries(fields).forEach(([field, value]) => {
    req = req.field(field, value);
  });
  if (content !== null) {
    req = req.attach('file', content, { filename: name, contentType: type });
  }
  return req;
}

const uploadOk = async (key, options) => (await upload(key, options).expect(201)).body.document;

const binary = (req) =>
  req
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

const tmpFiles = () => fs.readdirSync(env.UPLOAD_TMP_DIR);

beforeAll(async () => {
  await connectTestDb();
  await connectRedis();
  const keys = ['admin', 'hr', 'manager', 'empA', 'empB', 'empC', 'guest', 'adminB', 'empOtherOrg'];
  await Promise.all(keys.map(async (key) => { agents[key] = await createAgent(); }));
});

afterAll(async () => {
  await disconnectTestDb();
  await createRedisClient().quit();
  fs.rmSync(env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  orgA = await Organization.create({ name: 'Acme', slug: `acme-${Date.now()}`, createdBy: new mongoose.Types.ObjectId() });
  orgB = await Organization.create({ name: 'Globex', slug: `globex-${Date.now()}`, createdBy: new mongoose.Types.ObjectId() });

  await createUser(orgA, 'admin', ROLES.ORG_ADMIN);
  await createUser(orgA, 'hr', ROLES.HR);
  await createUser(orgA, 'manager', ROLES.MANAGER);
  await createUser(orgA, 'empA', ROLES.EMPLOYEE);
  await createUser(orgA, 'empB', ROLES.EMPLOYEE);
  await createUser(orgA, 'empC', ROLES.EMPLOYEE);
  await createUser(orgA, 'guest', ROLES.GUEST);
  await createUser(orgB, 'adminB', ROLES.ORG_ADMIN);
  await createUser(orgB, 'empOtherOrg', ROLES.EMPLOYEE);

  team = await Team.create({
    organization: orgA._id,
    name: 'Engineering',
    lead: users.manager._id,
    members: [users.manager._id, users.empA._id],
  });
  project = await Project.create({
    organization: orgA._id,
    owner: users.manager._id,
    createdBy: users.manager._id,
    name: 'Apollo',
    slug: 'apollo',
    visibility: 'Organization',
    members: [{ user: users.empA._id, role: 'Contributor' }],
  });
});

afterEach(async () => {
  await clearTestDb();
});

describe('upload & validation', () => {
  it('uploads a document, deriving type/size on the server and defaulting to private', async () => {
    const content = pdf('quarterly');
    const document = await uploadOk('empA', { name: 'Quarterly.pdf', content, fields: { description: 'Q3 numbers' } });

    expect(document).toMatchObject({
      name: 'Quarterly.pdf',
      extension: 'pdf',
      category: 'pdf',
      mimeType: 'application/pdf',
      size: content.length,
      visibility: 'private',
      currentVersion: 1,
      description: 'Q3 numbers',
      access: { canEdit: true, canManage: true, isOwner: true },
    });
    expect(document.owner.id).toBe(users.empA._id.toString());
    expect(document).not.toHaveProperty('storageKey');

    const file = await binary(as('empA').get(`/api/v1/documents/${document.id}/download`)).expect(200);
    expect(file.body.equals(content)).toBe(true);
  });

  it('never exposes the storage key in any response', async () => {
    const document = await uploadOk('empA');
    const list = await as('empA').get('/api/v1/documents').expect(200);
    const details = await as('empA').get(`/api/v1/documents/${document.id}`).expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/storageKey/);
    expect(JSON.stringify(details.body)).not.toMatch(/storageKey/);
  });

  it('rejects disallowed extensions, spoofed content and mismatched MIME types', async () => {
    const exe = await upload('empA', { name: 'setup.exe', content: Buffer.from('MZ....'), type: 'application/x-msdownload' }).expect(400);
    expect(exe.body.code).toBe('UNSUPPORTED_FILE_TYPE');

    const spoof = await upload('empA', { name: 'evil.pdf', content: Buffer.from('<script>alert(1)</script>') }).expect(400);
    expect(spoof.body.code).toBe('FILE_CONTENT_MISMATCH');

    const mime = await upload('empA', { name: 'a.pdf', type: 'image/png' }).expect(400);
    expect(mime.body.code).toBe('MIME_TYPE_MISMATCH');

    expect(await Document.countDocuments()).toBe(0);
    expect(tmpFiles()).toHaveLength(0); // failed uploads leave nothing behind
  });

  it('enforces the configured file-size limit and cleans up', async () => {
    const big = await upload('empA', { name: 'big.txt', content: Buffer.alloc(1.5 * 1024 * 1024, 97), type: 'text/plain' }).expect(413);
    expect(big.body.code).toBe('FILE_TOO_LARGE');
    expect(tmpFiles()).toHaveLength(0);
  });

  it('rejects empty files and a missing file', async () => {
    const empty = await upload('empA', { name: 'empty.txt', content: Buffer.alloc(0), type: 'text/plain' }).expect(400);
    expect(empty.body.code).toBe('EMPTY_FILE');
    const none = await upload('empA', { content: null }).expect(400);
    expect(none.body.code).toBe('FILE_REQUIRED');
    expect(tmpFiles()).toHaveLength(0);
  });

  it('neutralises path traversal in the client filename', async () => {
    const document = await uploadOk('empA', { name: '../../../etc/evil.pdf' });
    expect(document.name).toBe('evil.pdf');
  });

  it('rejects malformed upload fields and removes the temp file', async () => {
    const noTeam = await upload('empA', { fields: { visibility: 'team' } }).expect(400);
    expect(noTeam.body.code).toBe('VALIDATION_ERROR');
    await upload('empA', { fields: { visibility: 'public' } }).expect(400);
    await upload('empA', { fields: { folderId: 'not-an-id' } }).expect(400);
    expect(tmpFiles()).toHaveLength(0);
  });

  it('requires authentication and a CSRF token', async () => {
    await request(app).get('/api/v1/documents').expect(401);
    await agents.empA
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${signAccessToken({ sub: users.empA._id.toString(), tv: 0, sid: 's' })}`)
      .attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' })
      .expect(403);
  });

  it('returns 404 for malformed ids rather than erroring', async () => {
    await as('empA').get('/api/v1/documents/not-an-id').expect(404);
    await as('empA').get(`/api/v1/documents/${new mongoose.Types.ObjectId()}`).expect(404);
  });
});

describe('listing, search, filters, sorting, pagination', () => {
  beforeEach(async () => {
    await uploadOk('manager', { name: 'alpha.pdf', fields: { visibility: 'organization' }, content: pdf('a') });
    await uploadOk('manager', { name: 'bravo.txt', type: 'text/plain', content: Buffer.from('b'.repeat(500)), fields: { visibility: 'organization' } });
    await uploadOk('manager', { name: 'charlie.csv', type: 'text/csv', content: Buffer.from('a,b\n1,2\n'), fields: { visibility: 'organization' } });
    await uploadOk('manager', { name: 'delta.pdf', fields: { visibility: 'organization' }, content: pdf('d') });
    await uploadOk('manager', { name: 'echo.pdf', fields: { visibility: 'organization' }, content: pdf('e') });
  });

  it('paginates', async () => {
    const page2 = await as('empA').get('/api/v1/documents?limit=2&page=2&sortBy=name&sortOrder=asc').expect(200);
    expect(page2.body.pagination).toEqual({ page: 2, limit: 2, total: 5, pages: 3 });
    expect(page2.body.documents.map((d) => d.name)).toEqual(['charlie.csv', 'delta.pdf']);
  });

  it('searches by name (regex-safe) and filters by type, owner and date', async () => {
    const search = await as('empA').get('/api/v1/documents?search=ALPH').expect(200);
    expect(search.body.documents.map((d) => d.name)).toEqual(['alpha.pdf']);

    const regexChars = await as('empA').get('/api/v1/documents?search=' + encodeURIComponent('.*')).expect(200);
    expect(regexChars.body.documents).toHaveLength(0);

    const pdfs = await as('empA').get('/api/v1/documents?category=pdf').expect(200);
    expect(pdfs.body.pagination.total).toBe(3);

    const owner = await as('empA').get(`/api/v1/documents?ownerId=${users.manager._id}`).expect(200);
    expect(owner.body.pagination.total).toBe(5);
    const none = await as('empA').get(`/api/v1/documents?ownerId=${users.empB._id}`).expect(200);
    expect(none.body.pagination.total).toBe(0);

    const future = new Date(Date.now() + 86400000).toISOString();
    const dated = await as('empA').get(`/api/v1/documents?uploadedFrom=${encodeURIComponent(future)}`).expect(200);
    expect(dated.body.pagination.total).toBe(0);
  });

  it('sorts by size and name', async () => {
    const bySize = await as('empA').get('/api/v1/documents?sortBy=size&sortOrder=desc&limit=1').expect(200);
    expect(bySize.body.documents[0].name).toBe('bravo.txt');
    const byName = await as('empA').get('/api/v1/documents?sortBy=name&sortOrder=desc&limit=1').expect(200);
    expect(byName.body.documents[0].name).toBe('echo.pdf');
  });

  it('rejects unknown query parameters and bad pagination', async () => {
    await as('empA').get('/api/v1/documents?limit=1000').expect(400);
    await as('empA').get('/api/v1/documents?sortBy=password').expect(400);
    await as('empA').get('/api/v1/documents?organization=x').expect(400);
  });

  it('"mine" and "shared" scopes', async () => {
    await uploadOk('empA', { name: 'mine.pdf' });
    const mine = await as('empA').get('/api/v1/documents?scope=mine').expect(200);
    expect(mine.body.documents.map((d) => d.name)).toEqual(['mine.pdf']);
    const shared = await as('empA').get('/api/v1/documents?scope=shared').expect(200);
    expect(shared.body.documents).toHaveLength(0);
  });
});

describe('folders', () => {
  const create = async (key, name, parentId) =>
    (await as(key).post('/api/v1/documents/folders').send({ name, parentId }).expect(201)).body.folder;

  it('creates nested folders with breadcrumbs', async () => {
    const a = await create('empA', 'Finance');
    const b = await create('empA', '2026', a.id);
    const c = await create('empA', 'Q3', b.id);

    const root = await as('empA').get('/api/v1/documents/folders').expect(200);
    expect(root.body.folders.map((f) => f.name)).toEqual(['Finance']);

    const inner = await as('empA').get(`/api/v1/documents/folders?parentId=${b.id}`).expect(200);
    expect(inner.body.folders.map((f) => f.name)).toEqual(['Q3']);
    expect(inner.body.breadcrumb.map((x) => x.name)).toEqual(['Finance', '2026']);

    const all = await as('empA').get('/api/v1/documents/folders?all=true').expect(200);
    expect(all.body.folders).toHaveLength(3);
    expect(c.parent).toBe(b.id);
  });

  it('rejects duplicate sibling names (case-insensitive) and unsafe names', async () => {
    await create('empA', 'Finance');
    const dup = await as('empA').post('/api/v1/documents/folders').send({ name: 'finance' }).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_FOLDER_NAME');
    const unsafe = await create('empA', '../../etc');
    expect(unsafe.name).not.toMatch(/[/\\]/);
  });

  it('puts uploaded documents in a folder and moves them between folders', async () => {
    const a = await create('empA', 'A');
    const b = await create('empA', 'B');
    const document = await uploadOk('empA', { fields: { folderId: a.id } });
    expect(document.folder).toBe(a.id);

    const inA = await as('empA').get(`/api/v1/documents?folderId=${a.id}`).expect(200);
    expect(inA.body.documents).toHaveLength(1);

    await as('empA').post(`/api/v1/documents/${document.id}/move`).send({ folderId: b.id }).expect(200);
    expect((await as('empA').get(`/api/v1/documents?folderId=${a.id}`)).body.documents).toHaveLength(0);
    expect((await as('empA').get(`/api/v1/documents?folderId=${b.id}`)).body.documents).toHaveLength(1);

    await as('empA').post(`/api/v1/documents/${document.id}/move`).send({ folderId: null }).expect(200);
    expect((await as('empA').get('/api/v1/documents?folderId=root')).body.documents).toHaveLength(1);
  });

  it('prevents circular hierarchies and moving a folder into itself', async () => {
    const a = await create('empA', 'A');
    const b = await create('empA', 'B', a.id);
    const c = await create('empA', 'C', b.id);

    const self = await as('empA').patch(`/api/v1/documents/folders/${a.id}`).send({ parentId: a.id }).expect(400);
    expect(self.body.code).toBe('INVALID_FOLDER_MOVE');
    const descendant = await as('empA').patch(`/api/v1/documents/folders/${a.id}`).send({ parentId: c.id }).expect(400);
    expect(descendant.body.code).toBe('INVALID_FOLDER_MOVE');
  });

  it('moves a folder and keeps descendants\' paths valid', async () => {
    const a = await create('empA', 'A');
    const b = await create('empA', 'B', a.id);
    const c = await create('empA', 'C', b.id);
    const x = await create('empA', 'X');

    await as('empA').patch(`/api/v1/documents/folders/${b.id}`).send({ parentId: x.id }).expect(200);
    const crumbs = await as('empA').get(`/api/v1/documents/folders?parentId=${c.id}`).expect(200);
    expect(crumbs.body.breadcrumb.map((n) => n.name)).toEqual(['X', 'B', 'C']);
  });

  it('enforces a maximum nesting depth', async () => {
    let parentId;
    for (let depth = 0; depth < 10; depth += 1) {
      // eslint-disable-next-line no-await-in-loop
      parentId = (await create('empA', `L${depth}`, parentId)).id;
    }
    const tooDeep = await as('empA').post('/api/v1/documents/folders').send({ name: 'L10', parentId }).expect(400);
    expect(tooDeep.body.code).toBe('FOLDER_TOO_DEEP');
  });

  it('renames folders; only the owner or an admin may modify one', async () => {
    const folder = await create('empA', 'Mine');
    await as('empB').patch(`/api/v1/documents/folders/${folder.id}`).send({ name: 'Hijack' }).expect(403);
    await as('empB').delete(`/api/v1/documents/folders/${folder.id}`).expect(403);
    const renamed = await as('empA').patch(`/api/v1/documents/folders/${folder.id}`).send({ name: 'Renamed' }).expect(200);
    expect(renamed.body.folder.name).toBe('Renamed');
    await as('admin').patch(`/api/v1/documents/folders/${folder.id}`).send({ name: 'Admin Renamed' }).expect(200);
  });

  it('deleting a folder trashes its contents; restoring brings back exactly those', async () => {
    const parent = await create('empA', 'Parent');
    const child = await create('empA', 'Child', parent.id);
    const inParent = await uploadOk('empA', { name: 'p.pdf', fields: { folderId: parent.id } });
    const inChild = await uploadOk('empA', { name: 'c.pdf', fields: { folderId: child.id } });
    const alreadyGone = await uploadOk('empA', { name: 'gone.pdf', fields: { folderId: parent.id } });
    await as('empA').delete(`/api/v1/documents/${alreadyGone.id}`).expect(200);

    const del = await as('empA').delete(`/api/v1/documents/folders/${parent.id}`).expect(200);
    expect(del.body).toMatchObject({ trashedDocuments: 2, trashedFolders: 1 });
    await as('empA').get(`/api/v1/documents/${inParent.id}`).expect(404);
    await as('empA').get(`/api/v1/documents/${inChild.id}`).expect(404);

    // Trash shows the folder (top-level) but not the items trashed with it.
    const trash = await as('empA').get('/api/v1/documents/trash').expect(200);
    expect(trash.body.folders.map((f) => f.name)).toEqual(['Parent']);
    expect(trash.body.documents.map((d) => d.name)).toEqual(['gone.pdf']);

    const restored = await as('empA').post(`/api/v1/documents/folders/${parent.id}/restore`).expect(200);
    expect(restored.body.restoredToRoot).toBe(false);
    await as('empA').get(`/api/v1/documents/${inParent.id}`).expect(200);
    await as('empA').get(`/api/v1/documents/${inChild.id}`).expect(200);
    await as('empA').get(`/api/v1/documents/${alreadyGone.id}`).expect(404); // stays deleted
    const tree = await as('empA').get(`/api/v1/documents/folders?parentId=${child.id}`).expect(200);
    expect(tree.body.breadcrumb.map((n) => n.name)).toEqual(['Parent', 'Child']);
  });

  it('refuses to let a non-admin delete a folder holding other people\'s documents', async () => {
    const folder = await create('empA', 'Shared Space');
    await uploadOk('manager', { name: 'theirs.pdf', fields: { folderId: folder.id, visibility: 'organization' } });
    const res = await as('empA').delete(`/api/v1/documents/folders/${folder.id}`).expect(403);
    expect(res.body.code).toBe('FOLDER_HAS_OTHERS_ITEMS');
    await as('admin').delete(`/api/v1/documents/folders/${folder.id}`).expect(200);
  });

  it('restores a document to the root if its folder is still trashed', async () => {
    const folder = await create('empA', 'Temp');
    const document = await uploadOk('empA', { fields: { folderId: folder.id } });
    await as('empA').delete(`/api/v1/documents/${document.id}`).expect(200);
    await as('empA').delete(`/api/v1/documents/folders/${folder.id}`).expect(200);
    const res = await as('empA').post(`/api/v1/documents/${document.id}/restore`).expect(200);
    expect(res.body.restoredToRoot).toBe(true);
    const doc = await as('empA').get(`/api/v1/documents/${document.id}`).expect(200);
    expect(doc.body.document.folder).toBeNull();
  });

  it('gives guests an empty folder tree and no folder creation', async () => {
    await create('empA', 'Secret Projects');
    const tree = await as('guest').get('/api/v1/documents/folders').expect(200);
    expect(tree.body.folders).toEqual([]);
    await as('guest').post('/api/v1/documents/folders').send({ name: 'Nope' }).expect(403);
  });

  it('refuses folders from another organization', async () => {
    const foreign = await create('adminB', 'Globex Only');
    await upload('empA', { fields: { folderId: foreign.id } }).expect(404);
    await as('empA').post('/api/v1/documents/folders').send({ name: 'X', parentId: foreign.id }).expect(404);
    await as('empA').patch(`/api/v1/documents/folders/${foreign.id}`).send({ name: 'Hijack' }).expect(404);
    await as('empA').delete(`/api/v1/documents/folders/${foreign.id}`).expect(404);
  });
});

describe('access control by visibility', () => {
  it('private: only the owner (not even an org admin) can see it', async () => {
    const document = await uploadOk('empA');
    await as('empA').get(`/api/v1/documents/${document.id}`).expect(200);
    for (const key of ['empB', 'manager', 'hr', 'admin', 'guest']) {
      // eslint-disable-next-line no-await-in-loop
      await as(key).get(`/api/v1/documents/${document.id}`).expect(404);
      // eslint-disable-next-line no-await-in-loop
      await as(key).get(`/api/v1/documents/${document.id}/download`).expect(404);
      // eslint-disable-next-line no-await-in-loop
      const list = await as(key).get('/api/v1/documents').expect(200);
      expect(list.body.documents.map((d) => d.id)).not.toContain(document.id);
    }
  });

  it('team: members only, and removal from the team revokes access immediately', async () => {
    const document = await uploadOk('empA', { fields: { visibility: 'team', teamId: team._id.toString() } });

    await as('manager').get(`/api/v1/documents/${document.id}`).expect(200); // team lead
    await as('empB').get(`/api/v1/documents/${document.id}`).expect(404);
    await as('guest').get(`/api/v1/documents/${document.id}`).expect(404);
    const admin = await as('admin').get(`/api/v1/documents/${document.id}`).expect(200);
    expect(admin.body.document.access.canManage).toBe(true);

    await Team.updateOne({ _id: team._id }, { $addToSet: { members: users.empB._id } });
    await as('empB').get(`/api/v1/documents/${document.id}/download`).expect(200);

    await Team.updateOne({ _id: team._id }, { $pull: { members: users.empB._id } });
    await as('empB').get(`/api/v1/documents/${document.id}/download`).expect(404);
  });

  it('team visibility can only target a team the uploader belongs to', async () => {
    const res = await upload('empB', { fields: { visibility: 'team', teamId: team._id.toString() } }).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    // …but an HR admin may target any team.
    await uploadOk('hr', { fields: { visibility: 'team', teamId: team._id.toString() } });
    // A team from another org does not exist as far as we're concerned.
    const foreignTeam = await Team.create({ organization: orgB._id, name: 'Foreign', members: [] });
    await upload('empA', { fields: { visibility: 'team', teamId: foreignTeam._id.toString() } }).expect(404);
  });

  it('project: only real project members; revoked when removed from the project', async () => {
    const document = await uploadOk('empA', { fields: { visibility: 'project', projectId: project._id.toString() } });

    await as('manager').get(`/api/v1/documents/${document.id}`).expect(200); // project owner
    // Project is org-visible, but its documents are not.
    await as('empB').get(`/api/v1/documents/${document.id}`).expect(404);
    await as('admin').get(`/api/v1/documents/${document.id}`).expect(200);

    await Project.updateOne({ _id: project._id }, { $push: { members: { user: users.empB._id, role: 'Viewer' } } });
    await as('empB').get(`/api/v1/documents/${document.id}`).expect(200);
    await Project.updateOne({ _id: project._id }, { $pull: { members: { user: users.empB._id } } });
    await as('empB').get(`/api/v1/documents/${document.id}`).expect(404);

    // An employee cannot publish to a project they are not in.
    await upload('empC', { fields: { visibility: 'project', projectId: project._id.toString() } }).expect(403);
  });

  it('organization: everyone except guests; employees cannot publish org-wide', async () => {
    const policy = await upload('empA', { fields: { visibility: 'organization' } }).expect(403);
    expect(policy.body.code).toBe('ORG_PUBLISH_FORBIDDEN');

    const document = await uploadOk('manager', { fields: { visibility: 'organization' } });
    await as('empC').get(`/api/v1/documents/${document.id}`).expect(200);
    await as('hr').get(`/api/v1/documents/${document.id}`).expect(200);
    await as('guest').get(`/api/v1/documents/${document.id}`).expect(404);
  });

  it('guests are read-only and only see what is explicitly shared with them', async () => {
    const document = await uploadOk('manager', { fields: { visibility: 'organization' } });
    await as('guest').post('/api/v1/documents').attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' }).expect(403);
    await as('guest').delete(`/api/v1/documents/${document.id}`).expect(403);

    await as('manager').post(`/api/v1/documents/${document.id}/shares`).send({ userId: users.guest._id.toString() }).expect(200);
    const seen = await as('guest').get('/api/v1/documents').expect(200);
    expect(seen.body.documents.map((d) => d.id)).toEqual([document.id]);
    await as('guest').get(`/api/v1/documents/${document.id}/download`).expect(200);
    await as('guest').patch(`/api/v1/documents/${document.id}`).send({ name: 'x' }).expect(403);
    await as('guest').get('/api/v1/documents/trash').expect(403);
  });

  it('only the owner or an admin can change visibility, rename, move or delete', async () => {
    const document = await uploadOk('manager', { fields: { visibility: 'organization' } });
    await as('empA').patch(`/api/v1/documents/${document.id}`).send({ name: 'Mine now' }).expect(403);
    await as('empA').patch(`/api/v1/documents/${document.id}`).send({ visibility: 'private' }).expect(403);
    await as('empA').post(`/api/v1/documents/${document.id}/move`).send({ folderId: null }).expect(403);
    await as('empA').delete(`/api/v1/documents/${document.id}`).expect(403);

    await as('admin').patch(`/api/v1/documents/${document.id}`).send({ name: 'Policy' }).expect(200);
    const hidden = await as('manager').patch(`/api/v1/documents/${document.id}`).send({ visibility: 'private' }).expect(200);
    expect(hidden.body.document.visibility).toBe('private');
    await as('admin').get(`/api/v1/documents/${document.id}`).expect(404); // now private
  });

  it('keeps the original extension when renaming', async () => {
    const document = await uploadOk('empA', { name: 'a.pdf' });
    const res = await as('empA').patch(`/api/v1/documents/${document.id}`).send({ name: 'Budget 2026' }).expect(200);
    expect(res.body.document.name).toBe('Budget 2026.pdf');
    await as('empA').patch(`/api/v1/documents/${document.id}`).send({}).expect(400);
  });
});

describe('sharing', () => {
  it('shares with viewer then editor permission, lists access, and revokes', async () => {
    const document = await uploadOk('empA', { name: 'plan.pdf' });
    await as('empB').get(`/api/v1/documents/${document.id}`).expect(404);

    await as('empA').post(`/api/v1/documents/${document.id}/shares`).send({ userId: users.empB._id.toString() }).expect(200);
    const viewer = await as('empB').get(`/api/v1/documents/${document.id}`).expect(200);
    expect(viewer.body.document.access).toMatchObject({ canEdit: false, canManage: false, sharePermission: 'viewer' });
    await as('empB').patch(`/api/v1/documents/${document.id}`).send({ name: 'x' }).expect(403);

    const shared = await as('empB').get('/api/v1/documents?scope=shared').expect(200);
    expect(shared.body.documents.map((d) => d.id)).toEqual([document.id]);

    await as('empA').post(`/api/v1/documents/${document.id}/shares`).send({ userId: users.empB._id.toString(), permission: 'editor' }).expect(200);
    await as('empB').patch(`/api/v1/documents/${document.id}`).send({ name: 'Renamed by editor' }).expect(200);
    // …but an editor still cannot manage sharing or delete.
    await as('empB').post(`/api/v1/documents/${document.id}/shares`).send({ userId: users.empC._id.toString() }).expect(403);
    await as('empB').delete(`/api/v1/documents/${document.id}`).expect(403);

    const access = await as('empA').get(`/api/v1/documents/${document.id}/shares`).expect(200);
    expect(access.body.owner.id).toBe(users.empA._id.toString());
    expect(access.body.shares).toHaveLength(1);
    expect(access.body.shares[0]).toMatchObject({ permission: 'editor', active: true });
    await as('empB').get(`/api/v1/documents/${document.id}/shares`).expect(403);

    await as('empA').delete(`/api/v1/documents/${document.id}/shares/${users.empB._id}`).expect(200);
    await as('empB').get(`/api/v1/documents/${document.id}`).expect(404);
    await as('empA').delete(`/api/v1/documents/${document.id}/shares/${users.empB._id}`).expect(404);
  });

  it('rejects sharing with other-org, blocked, unknown or owner users, and editor grants to guests', async () => {
    const document = await uploadOk('empA');
    const share = (userId, body = {}) =>
      as('empA').post(`/api/v1/documents/${document.id}/shares`).send({ userId, ...body });

    expect((await share(users.empOtherOrg._id.toString()).expect(404)).body.code).toBe('NOT_FOUND');
    await share(new mongoose.Types.ObjectId().toString()).expect(404);
    await share('nope').expect(400);
    expect((await share(users.empA._id.toString()).expect(400)).body.code).toBe('ALREADY_OWNER');
    expect((await share(users.guest._id.toString(), { permission: 'editor' }).expect(400)).body.code).toBe('GUEST_VIEWER_ONLY');
    await share(users.guest._id.toString(), { permission: 'viewer' }).expect(200);

    await User.updateOne({ _id: users.empC._id }, { orgBlocked: true });
    expect((await share(users.empC._id.toString()).expect(400)).body.code).toBe('USER_INACTIVE');
  });

  it('marks shares to people who are later blocked as inactive', async () => {
    const document = await uploadOk('empA');
    await as('empA').post(`/api/v1/documents/${document.id}/shares`).send({ userId: users.empB._id.toString() }).expect(200);
    await User.updateOne({ _id: users.empB._id }, { orgBlocked: true });
    const access = await as('empA').get(`/api/v1/documents/${document.id}/shares`).expect(200);
    expect(access.body.shares[0].active).toBe(false);
  });
});

describe('versions', () => {
  it('uploads, lists, downloads and restores versions', async () => {
    const v1 = pdf('version one');
    const v2 = pdf('version two — longer');
    const document = await uploadOk('empA', { name: 'spec.pdf', content: v1 });

    const up = await upload('empA', {
      name: 'spec.pdf',
      content: v2,
      path: `/api/v1/documents/${document.id}/versions`,
      fields: { changeNote: 'Added section 2' },
    }).expect(201);
    expect(up.body.version).toBe(2);

    const current = await as('empA').get(`/api/v1/documents/${document.id}`).expect(200);
    expect(current.body.document).toMatchObject({ currentVersion: 2, size: v2.length });

    const list = await as('empA').get(`/api/v1/documents/${document.id}/versions`).expect(200);
    expect(list.body.versions.map((v) => [v.version, v.isCurrent])).toEqual([[2, true], [1, false]]);
    expect(list.body.versions[0].changeNote).toBe('Added section 2');
    expect(list.body.versions[0].uploadedBy.id).toBe(users.empA._id.toString());
    expect(JSON.stringify(list.body)).not.toMatch(/storageKey/);

    const old = await binary(as('empA').get(`/api/v1/documents/${document.id}/versions/1/download`)).expect(200);
    expect(old.body.equals(v1)).toBe(true);
    const now = await binary(as('empA').get(`/api/v1/documents/${document.id}/download`)).expect(200);
    expect(now.body.equals(v2)).toBe(true);

    const restored = await as('empA').post(`/api/v1/documents/${document.id}/versions/1/restore`).expect(200);
    expect(restored.body).toMatchObject({ version: 3, restoredFrom: 1 });
    const after = await binary(as('empA').get(`/api/v1/documents/${document.id}/download`)).expect(200);
    expect(after.body.equals(v1)).toBe(true);

    const final = await as('empA').get(`/api/v1/documents/${document.id}/versions`).expect(200);
    expect(final.body.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(final.body.versions[0].restoredFrom).toBe(1);

    // History is immutable: v2 is still intact after restoring v1.
    const v2again = await binary(as('empA').get(`/api/v1/documents/${document.id}/versions/2/download`)).expect(200);
    expect(v2again.body.equals(v2)).toBe(true);

    await as('empA').post(`/api/v1/documents/${document.id}/versions/3/restore`).expect(400); // already current
    await as('empA').post(`/api/v1/documents/${document.id}/versions/9/restore`).expect(404);
    await as('empA').get(`/api/v1/documents/${document.id}/versions/abc/download`).expect(404);
  });

  it('requires the same file type for a replacement', async () => {
    const document = await uploadOk('empA', { name: 'a.pdf' });
    const res = await upload('empA', {
      name: 'a.txt', content: Buffer.from('text'), type: 'text/plain', path: `/api/v1/documents/${document.id}/versions`,
    }).expect(400);
    expect(res.body.code).toBe('VERSION_TYPE_MISMATCH');
    await upload('empA', {
      name: 'a.pdf', content: Buffer.from('not a pdf'), path: `/api/v1/documents/${document.id}/versions`,
    }).expect(400);
    expect(await DocumentVersion.countDocuments({ document: document.id })).toBe(1);
    expect(tmpFiles()).toHaveLength(0);
  });

  it('hides history from viewers and non-editors; editors keep full access', async () => {
    const document = await uploadOk('empA', { name: 'a.pdf' });
    await upload('empA', { content: pdf('two'), path: `/api/v1/documents/${document.id}/versions` }).expect(201);

    await as('empA').post(`/api/v1/documents/${document.id}/shares`).send({ userId: users.empB._id.toString() }).expect(200);
    await as('empB').get(`/api/v1/documents/${document.id}/versions`).expect(403);
    await as('empB').get(`/api/v1/documents/${document.id}/versions/1/download`).expect(403);
    await as('empB').get(`/api/v1/documents/${document.id}/download`).expect(200); // current is fine
    await as('empB').post(`/api/v1/documents/${document.id}/versions/1/restore`).expect(403);
    await upload('empB', { content: pdf('x'), path: `/api/v1/documents/${document.id}/versions` }).expect(403);
    await as('empC').get(`/api/v1/documents/${document.id}/versions`).expect(404);

    await as('empA').post(`/api/v1/documents/${document.id}/shares`).send({ userId: users.empB._id.toString(), permission: 'editor' }).expect(200);
    await as('empB').get(`/api/v1/documents/${document.id}/versions`).expect(200);
    await upload('empB', { content: pdf('by editor'), path: `/api/v1/documents/${document.id}/versions` }).expect(201);
  });

  it('assigns unique numbers to concurrent uploads', async () => {
    const document = await uploadOk('empA', { name: 'a.pdf' });
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        upload('empA', { content: pdf(`concurrent ${n}`), path: `/api/v1/documents/${document.id}/versions` })),
    );
    const numbers = results.map((res) => res.body.version).sort();
    expect(numbers).toEqual([2, 3, 4]);
    expect(await DocumentVersion.countDocuments({ document: document.id })).toBe(4);
  });
});

describe('soft delete, trash & permanent deletion', () => {
  it('soft-deletes, lists in trash, restores', async () => {
    const document = await uploadOk('empA', { name: 'old.pdf' });
    await as('empA').delete(`/api/v1/documents/${document.id}`).expect(200);

    await as('empA').get(`/api/v1/documents/${document.id}`).expect(404);
    await as('empA').get(`/api/v1/documents/${document.id}/download`).expect(404);
    expect((await as('empA').get('/api/v1/documents')).body.documents).toHaveLength(0);

    const trash = await as('empA').get('/api/v1/documents/trash').expect(200);
    expect(trash.body.documents.map((d) => d.id)).toEqual([document.id]);
    expect((await as('empB').get('/api/v1/documents/trash')).body.documents).toHaveLength(0);
    await as('empB').post(`/api/v1/documents/${document.id}/restore`).expect(404);

    await as('empA').post(`/api/v1/documents/${document.id}/restore`).expect(200);
    await as('empA').get(`/api/v1/documents/${document.id}`).expect(200);
    expect((await as('empA').get('/api/v1/documents/trash')).body.documents).toHaveLength(0);
  });

  it('permanent deletion is restricted to admins and removes every version\'s file', async () => {
    const document = await uploadOk('manager', { name: 'p.pdf', fields: { visibility: 'organization' } });
    await upload('manager', { content: pdf('v2'), path: `/api/v1/documents/${document.id}/versions` }).expect(201);
    const keys = (await Document.findById(document.id).select('+storageKey')).storageKey;
    const versionKeys = (await DocumentVersion.find({ document: document.id }).select('+storageKey')).map((v) => v.storageKey);
    const storage = getStorage();
    for (const key of versionKeys) {
      // eslint-disable-next-line no-await-in-loop
      expect(await storage.stat(key)).not.toBeNull();
    }

    // Must be in the trash first, and the role must carry the permission.
    await as('admin').delete(`/api/v1/documents/${document.id}/permanent`).expect(404);
    await as('manager').delete(`/api/v1/documents/${document.id}`).expect(200);
    await as('manager').delete(`/api/v1/documents/${document.id}/permanent`).expect(403);
    await as('hr').delete(`/api/v1/documents/${document.id}/permanent`).expect(403);

    await as('admin').delete(`/api/v1/documents/${document.id}/permanent`).expect(200);
    expect(await Document.countDocuments({ _id: document.id })).toBe(0);
    expect(await DocumentVersion.countDocuments({ document: document.id })).toBe(0);
    expect(await storage.stat(keys)).toBeNull();
    for (const key of versionKeys) {
      // eslint-disable-next-line no-await-in-loop
      expect(await storage.stat(key)).toBeNull();
    }
  });

  it('does not let an admin touch someone else\'s private document, even in the trash', async () => {
    const document = await uploadOk('empA');
    await as('empA').delete(`/api/v1/documents/${document.id}`).expect(200);
    expect((await as('admin').get('/api/v1/documents/trash')).body.documents).toHaveLength(0);
    await as('admin').post(`/api/v1/documents/${document.id}/restore`).expect(404);
    await as('admin').delete(`/api/v1/documents/${document.id}/permanent`).expect(404);
  });

  it('permanently deletes a trashed folder tree', async () => {
    const folder = (await as('empA').post('/api/v1/documents/folders').send({ name: 'Tmp' }).expect(201)).body.folder;
    const document = await uploadOk('empA', { fields: { folderId: folder.id } });
    await as('empA').delete(`/api/v1/documents/folders/${folder.id}`).expect(200);
    await as('empA').delete(`/api/v1/documents/folders/${folder.id}/permanent`).expect(403); // employee: no permission
    await as('admin').delete(`/api/v1/documents/folders/${folder.id}/permanent`).expect(200);
    expect(await Document.countDocuments({ _id: document.id })).toBe(0);
  });
});

describe('organization isolation', () => {
  it('another organization can never see, download, change or share a document', async () => {
    const document = await uploadOk('manager', { name: 'secret.pdf', fields: { visibility: 'organization' } });
    const id = document.id;
    await upload('manager', { content: pdf('v2'), path: `/api/v1/documents/${id}/versions` }).expect(201);

    for (const key of ['adminB', 'empOtherOrg']) {
      const agent = as(key);
      const calls = [
        () => agent.get(`/api/v1/documents/${id}`),
        () => agent.get(`/api/v1/documents/${id}/download`),
        () => agent.get(`/api/v1/documents/${id}/versions`),
        () => agent.get(`/api/v1/documents/${id}/versions/1/download`),
        () => agent.get(`/api/v1/documents/${id}/shares`),
        () => agent.get(`/api/v1/documents/${id}/activity`),
        () => agent.patch(`/api/v1/documents/${id}`).send({ name: 'pwned' }),
        () => agent.post(`/api/v1/documents/${id}/move`).send({ folderId: null }),
        () => agent.post(`/api/v1/documents/${id}/shares`).send({ userId: users[key]._id.toString() }),
        () => agent.post(`/api/v1/documents/${id}/versions/1/restore`),
        () => agent.delete(`/api/v1/documents/${id}`),
        () => agent.post(`/api/v1/documents/${id}/restore`),
        () => agent.delete(`/api/v1/documents/${id}/permanent`),
      ];
      const results = [];
      for (const call of calls) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await call());
      }
      // 404 once a request reaches the document; 403 only where the role itself
      // lacks the permission (e.g. permanent delete) — never 200, never a leak.
      results.forEach((res) => expect([403, 404]).toContain(res.status));
      expect(results.filter((res) => res.status === 404).length).toBeGreaterThanOrEqual(calls.length - 1);
    }

    const list = await as('adminB').get('/api/v1/documents').expect(200);
    expect(list.body.documents).toHaveLength(0);
    expect(list.body.pagination.total).toBe(0);

    const still = await Document.findById(id);
    expect(still.name).toBe('secret.pdf');
    expect(still.deletedAt).toBeNull();
    expect(still.sharedWith).toHaveLength(0);
  });

  it('a document from one org cannot be shared with, or targeted at, another org\'s resources', async () => {
    const mine = await uploadOk('empA');
    await as('empA').post(`/api/v1/documents/${mine.id}/shares`).send({ userId: users.empOtherOrg._id.toString() }).expect(404);

    const foreignProject = await Project.create({
      organization: orgB._id, owner: users.adminB._id, createdBy: users.adminB._id, name: 'Foreign', slug: 'foreign',
    });
    await upload('admin', { fields: { visibility: 'project', projectId: foreignProject._id.toString() } }).expect(404);
  });

  it('keeps other organizations\' documents out of trash and folder views', async () => {
    const doc = await uploadOk('adminB', { fields: { visibility: 'organization' } });
    await as('adminB').delete(`/api/v1/documents/${doc.id}`).expect(200);
    expect((await as('admin').get('/api/v1/documents/trash')).body.documents).toHaveLength(0);
    await as('admin').post(`/api/v1/documents/${doc.id}/restore`).expect(404);
  });
});

describe('blocked users', () => {
  it('a user blocked from the organization loses all document access', async () => {
    const document = await uploadOk('manager', { fields: { visibility: 'organization' } });
    await as('empA').get(`/api/v1/documents/${document.id}/download`).expect(200);

    await User.updateOne({ _id: users.empA._id }, { orgBlocked: true });
    for (const path of [
      '/api/v1/documents',
      `/api/v1/documents/${document.id}`,
      `/api/v1/documents/${document.id}/download`,
      '/api/v1/documents/folders',
      '/api/v1/documents/trash',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await as('empA').get(path).expect(403);
      expect(res.body.code).toBe('ORG_BLOCKED');
    }
    await upload('empA').expect(403);
  });

  it('a user removed from the organization cannot reach documents shared with them', async () => {
    const document = await uploadOk('empA');
    await as('empA').post(`/api/v1/documents/${document.id}/shares`).send({ userId: users.empB._id.toString() }).expect(200);
    await as('empB').get(`/api/v1/documents/${document.id}`).expect(200);

    await User.updateOne({ _id: users.empB._id }, { organization: orgB._id });
    // Their new org does not contain the document, and the old one no longer lists them.
    await as('empB').get(`/api/v1/documents/${document.id}`).expect(404);
  });
});

describe('downloads', () => {
  it('serves attachments with safe headers and the server-derived content type', async () => {
    const document = await uploadOk('empA', { name: 'Q3 "final".pdf' });
    const res = await binary(as('empA').get(`/api/v1/documents/${document.id}/download`)).expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('allows inline preview only for safe types', async () => {
    const pdfDoc = await uploadOk('empA', { name: 'a.pdf' });
    const inline = await binary(as('empA').get(`/api/v1/documents/${pdfDoc.id}/download?disposition=inline`)).expect(200);
    expect(inline.headers['content-disposition']).toMatch(/^inline/);
    expect(inline.headers['content-security-policy']).toMatch(/sandbox/);

    const csv = await uploadOk('empA', { name: 'a.csv', type: 'text/csv', content: Buffer.from('a,b\n1,2\n') });
    const forced = await binary(as('empA').get(`/api/v1/documents/${csv.id}/download?disposition=inline`)).expect(200);
    expect(forced.headers['content-disposition']).toMatch(/^attachment/);

    await as('empA').get(`/api/v1/documents/${pdfDoc.id}/download?disposition=bogus`).expect(400);
  });

  it('answers 404 when the stored file has gone missing', async () => {
    const document = await uploadOk('empA');
    const record = await Document.findById(document.id).select('+storageKey');
    await getStorage().remove(record.storageKey);
    const res = await as('empA').get(`/api/v1/documents/${document.id}/download`).expect(404);
    expect(res.body.code).toBe('FILE_MISSING');
  });
});

describe('audit trail', () => {
  it('records document and folder events, scoped to the organization, without sensitive data', async () => {
    const folder = (await as('empA').post('/api/v1/documents/folders').send({ name: 'Ops' }).expect(201)).body.folder;
    await as('empA').patch(`/api/v1/documents/folders/${folder.id}`).send({ name: 'Operations' }).expect(200);
    const document = await uploadOk('empA', { name: 'log.pdf' });
    await as('empA').patch(`/api/v1/documents/${document.id}`).send({ name: 'log-2' }).expect(200);
    await as('empA').post(`/api/v1/documents/${document.id}/move`).send({ folderId: folder.id }).expect(200);
    await as('empA').post(`/api/v1/documents/${document.id}/shares`).send({ userId: users.empB._id.toString() }).expect(200);
    await as('empA').delete(`/api/v1/documents/${document.id}/shares/${users.empB._id}`).expect(200);
    await as('empA').patch(`/api/v1/documents/${document.id}`).send({ visibility: 'team', teamId: team._id.toString() }).expect(200);
    await upload('empA', { content: pdf('v2'), path: `/api/v1/documents/${document.id}/versions` }).expect(201);
    await as('empA').post(`/api/v1/documents/${document.id}/versions/1/restore`).expect(200);
    await as('empA').get(`/api/v1/documents/${document.id}/download`).expect(200);
    await as('empA').delete(`/api/v1/documents/${document.id}`).expect(200);
    await as('empA').post(`/api/v1/documents/${document.id}/restore`).expect(200);

    const logs = await AuditLog.find({ organization: orgA._id });
    const actions = logs.map((log) => log.action);
    expect(actions).toEqual(expect.arrayContaining([
      'document_folder.created', 'document_folder.renamed',
      'document.uploaded', 'document.renamed', 'document.moved', 'document.shared',
      'document.share_revoked', 'document.visibility_changed', 'document.version_uploaded',
      'document.version_restored', 'document.downloaded', 'document.deleted', 'document.restored',
    ]));
    logs.forEach((log) => {
      expect(JSON.stringify(log.metadata)).not.toMatch(/storageKey|checksum/);
      expect(log.organization.toString()).toBe(orgA._id.toString());
    });

    const activity = await as('empA').get(`/api/v1/documents/${document.id}/activity`).expect(200);
    expect(activity.body.activity[0]).toHaveProperty('action');
    expect(activity.body.activity.every((a) => a.action.startsWith('document.'))).toBe(true);
    // Viewers can't read the activity trail.
    await as('empB').get(`/api/v1/documents/${document.id}/activity`).expect(404);

    await as('empA').delete(`/api/v1/documents/folders/${folder.id}`).expect(200);
    expect(await AuditLog.countDocuments({ organization: orgA._id, action: 'document_folder.deleted' })).toBe(1);
  });
});

describe('role permissions', () => {
  it('gives every role only the document permissions it needs', async () => {
    const { ROLE_PERMISSIONS } = require('../../src/constants/rolePermissions');
    const { PERMISSIONS } = require('../../src/constants/permissions');

    expect(ROLE_PERMISSIONS[ROLES.GUEST]).toContain(PERMISSIONS.VIEW_DOCUMENT);
    [PERMISSIONS.UPLOAD_DOCUMENT, PERMISSIONS.CREATE_FOLDER, PERMISSIONS.DELETE_DOCUMENT, PERMISSIONS.SHARE_DOCUMENT,
      PERMISSIONS.PERMANENTLY_DELETE_DOCUMENT].forEach((permission) => {
      expect(ROLE_PERMISSIONS[ROLES.GUEST]).not.toContain(permission);
    });
    [ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE].forEach((role) => {
      expect(ROLE_PERMISSIONS[role]).not.toContain(PERMISSIONS.PERMANENTLY_DELETE_DOCUMENT);
    });
    [ROLES.ORG_ADMIN, ROLES.ADMIN].forEach((role) => {
      expect(ROLE_PERMISSIONS[role]).toContain(PERMISSIONS.PERMANENTLY_DELETE_DOCUMENT);
    });
  });
});
