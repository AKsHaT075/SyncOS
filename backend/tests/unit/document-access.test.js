const mongoose = require('mongoose');
const { ROLES } = require('../../src/constants/roles');
const {
  buildAccessContext,
  buildDocumentVisibilityFilter,
  resolveDocumentAccess,
} = require('../../src/utils/documentAccess');

const id = () => new mongoose.Types.ObjectId();
const org = id();
const otherOrg = id();

function user(role, overrides = {}) {
  return { _id: id(), organization: org, role, ...overrides };
}

function doc(overrides = {}) {
  return {
    organization: org,
    owner: id(),
    visibility: 'private',
    team: null,
    project: null,
    sharedWith: [],
    ...overrides,
  };
}

const ctxFor = (u, memberships = {}) => buildAccessContext(u, memberships);

describe('resolveDocumentAccess', () => {
  it('private: only the owner and explicit shares — not even org admins', () => {
    const owner = user(ROLES.EMPLOYEE);
    const sharedUser = user(ROLES.EMPLOYEE);
    const admin = user(ROLES.ORG_ADMIN);
    const stranger = user(ROLES.EMPLOYEE);
    const document = doc({
      owner: owner._id,
      sharedWith: [{ user: sharedUser._id, permission: 'viewer' }],
    });

    expect(resolveDocumentAccess(ctxFor(owner), document)).toMatchObject({ canView: true, canEdit: true, canManage: true });
    expect(resolveDocumentAccess(ctxFor(sharedUser), document)).toMatchObject({ canView: true, canEdit: false, canManage: false });
    expect(resolveDocumentAccess(ctxFor(admin), document).canView).toBe(false);
    expect(resolveDocumentAccess(ctxFor(stranger), document).canView).toBe(false);
  });

  it('an editor share grants edit but not manage', () => {
    const editor = user(ROLES.EMPLOYEE);
    const document = doc({ sharedWith: [{ user: editor._id, permission: 'editor' }] });
    expect(resolveDocumentAccess(ctxFor(editor), document)).toMatchObject({ canView: true, canEdit: true, canManage: false });
  });

  it('team: current team members only, plus admins', () => {
    const teamId = id();
    const member = user(ROLES.EMPLOYEE);
    const outsider = user(ROLES.EMPLOYEE);
    const admin = user(ROLES.ADMIN);
    const document = doc({ visibility: 'team', team: teamId });

    expect(resolveDocumentAccess(ctxFor(member, { teamIds: [teamId.toString()] }), document).canView).toBe(true);
    expect(resolveDocumentAccess(ctxFor(outsider), document).canView).toBe(false);
    // Leaving the team revokes access immediately — nothing on the doc changes.
    expect(resolveDocumentAccess(ctxFor(member, { teamIds: [] }), document).canView).toBe(false);
    expect(resolveDocumentAccess(ctxFor(admin), document)).toMatchObject({ canView: true, canManage: true });
  });

  it('project: only real project members (not just anyone who can see the project)', () => {
    const projectId = id();
    const member = user(ROLES.EMPLOYEE);
    const outsider = user(ROLES.EMPLOYEE);
    const document = doc({ visibility: 'project', project: projectId });

    expect(resolveDocumentAccess(ctxFor(member, { projectIds: [projectId.toString()] }), document).canView).toBe(true);
    expect(resolveDocumentAccess(ctxFor(outsider), document).canView).toBe(false);
  });

  it('organization: everyone in the org except guests', () => {
    const document = doc({ visibility: 'organization' });
    expect(resolveDocumentAccess(ctxFor(user(ROLES.EMPLOYEE)), document).canView).toBe(true);
    expect(resolveDocumentAccess(ctxFor(user(ROLES.HR)), document).canView).toBe(true);
    expect(resolveDocumentAccess(ctxFor(user(ROLES.GUEST)), document).canView).toBe(false);
  });

  it('guests: only explicit shares or explicit project membership, and never write', () => {
    const projectId = id();
    const guest = user(ROLES.GUEST);

    const shared = doc({ visibility: 'private', sharedWith: [{ user: guest._id, permission: 'editor' }] });
    expect(resolveDocumentAccess(ctxFor(guest), shared)).toMatchObject({ canView: true, canEdit: false });

    const projectDoc = doc({ visibility: 'project', project: projectId });
    expect(resolveDocumentAccess(ctxFor(guest, { projectIds: [projectId.toString()] }), projectDoc).canView).toBe(true);
    expect(resolveDocumentAccess(ctxFor(guest, { teamIds: [id().toString()] }), doc({ visibility: 'team', team: id() })).canView).toBe(false);
  });

  it('never grants access across organizations, whatever the visibility', () => {
    const teamId = id();
    const foreigner = user(ROLES.ORG_ADMIN, { organization: otherOrg });
    const document = doc({ visibility: 'organization', team: teamId });
    expect(resolveDocumentAccess(ctxFor(foreigner, { teamIds: [teamId.toString()] }), document)).toMatchObject({
      canView: false,
      canEdit: false,
      canManage: false,
    });
  });

  it('org admins manage non-private documents they do not own', () => {
    const admin = user(ROLES.ORG_ADMIN);
    const document = doc({ visibility: 'organization' });
    expect(resolveDocumentAccess(ctxFor(admin), document)).toMatchObject({ canView: true, canEdit: true, canManage: true, isOwner: false });
  });
});

describe('buildDocumentVisibilityFilter', () => {
  it('lists only owner/shared for a guest with no projects', () => {
    const guest = user(ROLES.GUEST);
    const filter = buildDocumentVisibilityFilter(ctxFor(guest));
    expect(filter.$or).toEqual([{ owner: guest._id }, { 'sharedWith.user': guest._id }]);
  });

  it('includes organization + own-team + own-project clauses for an employee', () => {
    const employee = user(ROLES.EMPLOYEE);
    const teamId = id().toString();
    const projectId = id().toString();
    const { $or } = buildDocumentVisibilityFilter(ctxFor(employee, { teamIds: [teamId], projectIds: [projectId] }));
    expect($or).toContainEqual({ visibility: 'organization' });
    expect($or).toContainEqual({ visibility: 'team', team: { $in: [teamId] } });
    expect($or).toContainEqual({ visibility: 'project', project: { $in: [projectId] } });
  });

  it('excludes private documents from the admin clause', () => {
    const admin = user(ROLES.ORG_ADMIN);
    const { $or } = buildDocumentVisibilityFilter(ctxFor(admin));
    const adminClause = $or.find((clause) => clause.visibility && clause.visibility.$in);
    expect(adminClause.visibility.$in).not.toContain('private');
  });
});
