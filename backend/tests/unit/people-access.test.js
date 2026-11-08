const { ROLES } = require('../../src/constants/roles');
const {
  buildPeopleDirectoryFilter,
  canViewPerson,
  canManageUsers,
  serializePerson,
} = require('../../src/utils/peopleAccess');

const orgA = { _id: 'org-a', toString: () => 'org-a' };
const orgB = { _id: 'org-b', toString: () => 'org-b' };

function user(overrides = {}) {
  return {
    _id: { toString: () => 'user-x' },
    organization: orgA,
    role: ROLES.EMPLOYEE,
    isActive: true,
    ...overrides,
  };
}

function person(overrides = {}) {
  return {
    _id: { toString: () => 'person-1' },
    organization: orgA,
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@acme.test',
    role: ROLES.EMPLOYEE,
    skills: ['node', 'react'],
    team: null,
    presenceStatus: 'online',
    isActive: true,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
    ...overrides,
  };
}

describe('buildPeopleDirectoryFilter', () => {
  it('org-admin/admin/hr see the whole directory including inactive members', () => {
    [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR].forEach((role) => {
      expect(buildPeopleDirectoryFilter(user({ role }))).toEqual({});
    });
  });

  it('manager/employee/guest only see active members', () => {
    [ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.GUEST].forEach((role) => {
      expect(buildPeopleDirectoryFilter(user({ role }))).toEqual({ isActive: true });
    });
  });
});

describe('canViewPerson', () => {
  it('rejects cross-organization access for every role', () => {
    const crossOrgTarget = person({ organization: orgB });
    [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.GUEST].forEach(
      (role) => {
        expect(canViewPerson(user({ role }), crossOrgTarget)).toBe(false);
      }
    );
  });

  it('org-admin/admin/hr can view any org member, active or not', () => {
    [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR].forEach((role) => {
      expect(canViewPerson(user({ role }), person())).toBe(true);
      expect(canViewPerson(user({ role }), person({ isActive: false }))).toBe(true);
    });
  });

  it('manager/employee/guest can only view active org members', () => {
    [ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.GUEST].forEach((role) => {
      expect(canViewPerson(user({ role }), person())).toBe(true);
      expect(canViewPerson(user({ role }), person({ isActive: false }))).toBe(false);
    });
  });
});

describe('serializePerson', () => {
  it('never leaks auth/security fields to any viewer role', () => {
    [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.GUEST].forEach(
      (role) => {
        const serialized = serializePerson(person(), user({ role }));
        expect(serialized).not.toHaveProperty('emailVerified');
        expect(serialized).not.toHaveProperty('hasCreatedOrganization');
        expect(serialized).not.toHaveProperty('tokenVersion');
        expect(serialized).not.toHaveProperty('failedLoginAttempts');
        expect(serialized).not.toHaveProperty('lockUntil');
        expect(serialized).not.toHaveProperty('passwordChangedAt');
        expect(serialized).not.toHaveProperty('organization');
      }
    );
  });

  it('guest gets a limited directory entry without email or skills', () => {
    const serialized = serializePerson(person(), user({ role: ROLES.GUEST }));
    expect(serialized).toMatchObject({
      id: 'person-1',
      fullName: 'Jane Doe',
      role: ROLES.EMPLOYEE,
      isActive: true,
    });
    expect(serialized.email).toBeUndefined();
    expect(serialized.skills).toBeUndefined();
    expect(serialized.presenceStatus).toBeUndefined();
  });

  it('manager/employee see email and skills, but not presence or timestamps', () => {
    [ROLES.MANAGER, ROLES.EMPLOYEE].forEach((role) => {
      const serialized = serializePerson(person(), user({ role }));
      expect(serialized.email).toBe('jane@acme.test');
      expect(serialized.skills).toEqual(['node', 'react']);
      expect(serialized.presenceStatus).toBeUndefined();
      expect(serialized.createdAt).toBeUndefined();
    });
  });

  it('org-admin/admin/hr see the full safe field set', () => {
    [ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR].forEach((role) => {
      const serialized = serializePerson(person(), user({ role }));
      expect(serialized.email).toBe('jane@acme.test');
      expect(serialized.skills).toEqual(['node', 'react']);
      expect(serialized.presenceStatus).toBe('online');
      expect(serialized.createdAt).toBeInstanceOf(Date);
    });
  });

  it('serializes a populated team as { id, name }', () => {
    const withTeam = person({ team: { _id: { toString: () => 'team-1' }, name: 'Engineering' } });
    const serialized = serializePerson(withTeam, user({ role: ROLES.EMPLOYEE }));
    expect(serialized.team).toEqual({ id: 'team-1', name: 'Engineering' });
  });

  it('serializes a bare team ObjectId without a name', () => {
    const withTeam = person({ team: { toString: () => 'team-1' } });
    const serialized = serializePerson(withTeam, user({ role: ROLES.ORG_ADMIN }));
    expect(serialized.team).toEqual({ id: 'team-1', name: null });
  });
});

describe('canManageUsers (reused via peopleAccess)', () => {
  it('hr can manage employees but not managers, hr peers, or admins', () => {
    expect(canManageUsers(user({ role: ROLES.HR }), person({ role: ROLES.EMPLOYEE }))).toBe(true);
    expect(canManageUsers(user({ role: ROLES.HR }), person({ role: ROLES.MANAGER }))).toBe(false);
    expect(canManageUsers(user({ role: ROLES.HR }), person({ role: ROLES.HR }))).toBe(false);
    expect(canManageUsers(user({ role: ROLES.HR }), person({ role: ROLES.ADMIN }))).toBe(false);
  });

  it('org-admin/admin can manage any org member', () => {
    [ROLES.ORG_ADMIN, ROLES.ADMIN].forEach((role) => {
      expect(canManageUsers(user({ role }), person({ role: ROLES.EMPLOYEE }))).toBe(true);
      expect(canManageUsers(user({ role }), person({ role: ROLES.ADMIN }))).toBe(true);
    });
  });

  it('manager/employee/guest cannot manage anyone', () => {
    [ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.GUEST].forEach((role) => {
      expect(canManageUsers(user({ role }), person({ role: ROLES.EMPLOYEE }))).toBe(false);
    });
  });

  it('rejects managing users outside the actor organization', () => {
    expect(
      canManageUsers(user({ role: ROLES.ORG_ADMIN }), person({ organization: orgB, role: ROLES.EMPLOYEE }))
    ).toBe(false);
  });
});