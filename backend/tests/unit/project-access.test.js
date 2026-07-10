const mongoose = require('mongoose');
const {
  buildProjectVisibilityFilter,
  canManageProject,
  canViewProject,
  getProjectMemberRole,
} = require('../../src/utils/projectAccess');
const { ROLES } = require('../../src/constants/roles');
const { PROJECT_VISIBILITY, PROJECT_MEMBER_ROLES } = require('../../src/constants/project.constants');

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const teamA = new mongoose.Types.ObjectId();
const teamB = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const memberId = new mongoose.Types.ObjectId();
const strangerId = new mongoose.Types.ObjectId();

function makeProject(overrides = {}) {
  return {
    organization: orgA,
    owner: ownerId,
    team: teamA,
    visibility: PROJECT_VISIBILITY.TEAM,
    members: [{ user: memberId, role: PROJECT_MEMBER_ROLES.CONTRIBUTOR }],
    ...overrides,
  };
}

describe('getProjectMemberRole', () => {
  it('returns OWNER for the project owner', () => {
    const project = makeProject();
    expect(getProjectMemberRole(project, ownerId)).toBe(PROJECT_MEMBER_ROLES.OWNER);
  });

  it("returns the member's stored role", () => {
    const project = makeProject();
    expect(getProjectMemberRole(project, memberId)).toBe(PROJECT_MEMBER_ROLES.CONTRIBUTOR);
  });

  it('returns null for someone not on the project', () => {
    const project = makeProject();
    expect(getProjectMemberRole(project, strangerId)).toBeNull();
  });
});

describe('canViewProject', () => {
  it('blocks cross-organization access even for org admins', () => {
    const user = { _id: strangerId, organization: orgB, role: ROLES.ORG_ADMIN };
    expect(canViewProject(user, makeProject())).toBe(false);
  });

  it('lets ORG_ADMIN and ADMIN view any project in their org', () => {
    const project = makeProject({ visibility: PROJECT_VISIBILITY.PRIVATE });
    expect(canViewProject({ _id: strangerId, organization: orgA, role: ROLES.ORG_ADMIN }, project)).toBe(true);
    expect(canViewProject({ _id: strangerId, organization: orgA, role: ROLES.ADMIN }, project)).toBe(true);
  });

  it('lets an explicit member view a Private project', () => {
    const project = makeProject({ visibility: PROJECT_VISIBILITY.PRIVATE });
    const user = { _id: memberId, organization: orgA, role: ROLES.EMPLOYEE };
    expect(canViewProject(user, project)).toBe(true);
  });

  it('blocks a non-member from a Private project', () => {
    const project = makeProject({ visibility: PROJECT_VISIBILITY.PRIVATE });
    const user = { _id: strangerId, organization: orgA, role: ROLES.EMPLOYEE, team: teamA };
    expect(canViewProject(user, project)).toBe(false);
  });

  it('lets a same-team employee view a Team-visibility project', () => {
    const project = makeProject({ visibility: PROJECT_VISIBILITY.TEAM });
    const user = { _id: strangerId, organization: orgA, role: ROLES.EMPLOYEE, team: teamA };
    expect(canViewProject(user, project)).toBe(true);
  });

  it('blocks a different-team employee from a Team-visibility project', () => {
    const project = makeProject({ visibility: PROJECT_VISIBILITY.TEAM });
    const user = { _id: strangerId, organization: orgA, role: ROLES.EMPLOYEE, team: teamB };
    expect(canViewProject(user, project)).toBe(false);
  });

  it('lets any org member view an Organization-visibility project', () => {
    const project = makeProject({ visibility: PROJECT_VISIBILITY.ORGANIZATION });
    const user = { _id: strangerId, organization: orgA, role: ROLES.GUEST, team: teamB };
    expect(canViewProject(user, project)).toBe(true);
  });
});

describe('canManageProject', () => {
  it('blocks cross-organization management', () => {
    const user = { _id: ownerId, organization: orgB, role: ROLES.ORG_ADMIN };
    expect(canManageProject(user, makeProject())).toBe(false);
  });

  it('lets ORG_ADMIN and ADMIN manage any project in their org', () => {
    const project = makeProject();
    expect(canManageProject({ _id: strangerId, organization: orgA, role: ROLES.ORG_ADMIN }, project)).toBe(true);
    expect(canManageProject({ _id: strangerId, organization: orgA, role: ROLES.ADMIN }, project)).toBe(true);
  });

  it('lets the project owner manage it regardless of org role', () => {
    const project = makeProject();
    const user = { _id: ownerId, organization: orgA, role: ROLES.EMPLOYEE };
    expect(canManageProject(user, project)).toBe(true);
  });

  it('lets a project member with the Manager project-role manage it', () => {
    const managerMemberId = new mongoose.Types.ObjectId();
    const project = makeProject({
      members: [{ user: managerMemberId, role: PROJECT_MEMBER_ROLES.MANAGER }],
    });
    const user = { _id: managerMemberId, organization: orgA, role: ROLES.EMPLOYEE };
    expect(canManageProject(user, project)).toBe(true);
  });

  it('blocks a Contributor project-role from managing it', () => {
    const project = makeProject();
    const user = { _id: memberId, organization: orgA, role: ROLES.EMPLOYEE };
    expect(canManageProject(user, project)).toBe(false);
  });

  it("lets an org MANAGER manage a project on their own team, even if not a member", () => {
    const project = makeProject({ team: teamA });
    const user = { _id: strangerId, organization: orgA, role: ROLES.MANAGER, team: teamA };
    expect(canManageProject(user, project)).toBe(true);
  });

  it("blocks an org MANAGER from managing a project on a different team", () => {
    const project = makeProject({ team: teamA });
    const user = { _id: strangerId, organization: orgA, role: ROLES.MANAGER, team: teamB };
    expect(canManageProject(user, project)).toBe(false);
  });
});

describe('buildProjectVisibilityFilter', () => {
  it('returns an unrestricted filter for ORG_ADMIN and ADMIN', () => {
    expect(buildProjectVisibilityFilter({ _id: strangerId, role: ROLES.ORG_ADMIN })).toEqual({});
    expect(buildProjectVisibilityFilter({ _id: strangerId, role: ROLES.ADMIN })).toEqual({});
  });

  it('includes an org-wide team clause only when the user has a team', () => {
    const withTeam = buildProjectVisibilityFilter({ _id: strangerId, role: ROLES.EMPLOYEE, team: teamA });
    expect(withTeam.$or).toContainEqual({ visibility: PROJECT_VISIBILITY.TEAM, team: teamA });

    const withoutTeam = buildProjectVisibilityFilter({ _id: strangerId, role: ROLES.EMPLOYEE, team: null });
    expect(withoutTeam.$or.some((clause) => clause.visibility === PROJECT_VISIBILITY.TEAM)).toBe(false);
  });
});
