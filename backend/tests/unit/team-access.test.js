const { ROLES } = require('../../src/constants/roles');
const {
  canManageTeamMembers,
  canViewTeam,
  getTeamStanding,
} = require('../../src/utils/teamAccess');

const orgA = { _id: 'org-a', toString: () => 'org-a' };
const orgB = { _id: 'org-b', toString: () => 'org-b' };

function user(id, overrides = {}) {
  return {
    _id: { toString: () => id },
    organization: orgA,
    role: ROLES.EMPLOYEE,
    ...overrides,
  };
}

function team(overrides = {}) {
  return {
    _id: { toString: () => 'team-1' },
    organization: orgA,
    name: 'Engineering',
    lead: null,
    members: [],
    ...overrides,
  };
}

describe('canViewTeam', () => {
  it('org-admin/admin/hr can view any team in their organization', () => {
    [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR].forEach((role) => {
      expect(canViewTeam(user('actor', { role }), team())).toBe(true);
    });
  });

  it('a lead can view their own team regardless of org role (EMPLOYEE lead is valid)', () => {
    const leadId = 'lead-1';
    const t = team({ lead: { toString: () => leadId } });
    expect(canViewTeam(user('lead-1', { role: ROLES.EMPLOYEE }), t)).toBe(true);
  });

  it('a member can view their own team', () => {
    const memberId = 'member-1';
    const memberDoc = { toString: () => memberId };
    const t = team({ members: [memberDoc] });
    expect(canViewTeam(user(memberId), t)).toBe(true);
  });

  it('a member of one team cannot view another team', () => {
    const t = team({ members: [{ toString: () => 'someone-else' }] });
    expect(canViewTeam(user('not-on-team'), t)).toBe(false);
  });

  it('never grants cross-organization team access', () => {
    const crossOrg = team({ organization: orgB });
    [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.GUEST].forEach(
      (role) => {
        expect(canViewTeam(user('actor', { role }), crossOrg)).toBe(false);
      }
    );
  });
});

describe('canManageTeamMembers', () => {
  it('only org-admin/admin/hr may manage team members', () => {
    [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR].forEach((role) => {
      expect(canManageTeamMembers(user('actor', { role }), team())).toBe(true);
    });

    [ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.GUEST].forEach((role) => {
      expect(canManageTeamMembers(user('actor', { role }), team())).toBe(false);
    });
  });

  it('a team lead with org role EMPLOYEE still has no team admin power', () => {
    const t = team({ lead: { toString: () => 'lead-1' } });
    expect(canManageTeamMembers(user('lead-1', { role: ROLES.EMPLOYEE }), t)).toBe(false);
  });

  it('never allows cross-organization member management', () => {
    const crossOrg = team({ organization: orgB });
    expect(canManageTeamMembers(user('actor', { role: ROLES.ORG_ADMIN }), crossOrg)).toBe(false);
    expect(canManageTeamMembers(user('actor', { role: ROLES.HR }), crossOrg)).toBe(false);
  });
});

describe('getTeamStanding', () => {
  it('returns lead, member, or null', () => {
    const t = team({ lead: { toString: () => 'lead-1' }, members: [{ toString: () => 'member-1' }] });
    expect(getTeamStanding(user('lead-1'), t)).toBe('lead');
    expect(getTeamStanding(user('member-1'), t)).toBe('member');
    expect(getTeamStanding(user('outsider'), t)).toBe(null);
  });
});