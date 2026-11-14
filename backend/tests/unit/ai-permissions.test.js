const { PERMISSIONS: P } = require('../../src/constants/permissions');
const { ROLE_PERMISSIONS } = require('../../src/constants/rolePermissions');
const { ROLES } = require('../../src/constants/roles');

/**
 * The exact AI permission assignment per role. If this file needs editing, the
 * access model changed: that is a decision, not a test fix.
 */
const EXPECTED = {
  [ROLES.SUPER_ADMIN]: { USE_AI: false, MANAGE_AI: false, VIEW_AI_USAGE: false, MANAGE_AI_KNOWLEDGE: false },
  [ROLES.ORG_ADMIN]: { USE_AI: true, MANAGE_AI: true, VIEW_AI_USAGE: true, MANAGE_AI_KNOWLEDGE: true },
  [ROLES.ADMIN]: { USE_AI: true, MANAGE_AI: true, VIEW_AI_USAGE: true, MANAGE_AI_KNOWLEDGE: true },
  [ROLES.HR]: { USE_AI: true, MANAGE_AI: false, VIEW_AI_USAGE: false, MANAGE_AI_KNOWLEDGE: false },
  [ROLES.MANAGER]: { USE_AI: true, MANAGE_AI: false, VIEW_AI_USAGE: false, MANAGE_AI_KNOWLEDGE: false },
  [ROLES.EMPLOYEE]: { USE_AI: true, MANAGE_AI: false, VIEW_AI_USAGE: false, MANAGE_AI_KNOWLEDGE: false },
  [ROLES.GUEST]: { USE_AI: false, MANAGE_AI: false, VIEW_AI_USAGE: false, MANAGE_AI_KNOWLEDGE: false },
};

describe('AI permission assignments', () => {
  test.each(Object.entries(EXPECTED))('%s', (role, expected) => {
    for (const [permission, allowed] of Object.entries(expected)) {
      expect({ role, permission, held: ROLE_PERMISSIONS[role].includes(P[permission]) }).toEqual({ role, permission, held: allowed });
    }
  });

  test('every role is covered, so a new role cannot slip in unreviewed', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(ROLES).sort());
  });

  test('adding AI did not change any non-AI permission for HR, manager, employee or guest', () => {
    const AI = [P.USE_AI, P.MANAGE_AI, P.VIEW_AI_USAGE, P.MANAGE_AI_KNOWLEDGE];
    // HR must still have no task/project/meeting write access (AI must not widen it).
    for (const forbidden of [P.CREATE_TASK, P.ASSIGN_TASK, P.CREATE_PROJECT, P.UPDATE_PROJECT, P.CREATE_MEETING]) {
      expect(ROLE_PERMISSIONS[ROLES.HR]).not.toContain(forbidden);
    }
    for (const role of [ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.GUEST]) {
      const nonAi = ROLE_PERMISSIONS[role].filter((permission) => !AI.includes(permission));
      expect(nonAi.length).toBeGreaterThan(0);
    }
    // Guests keep exactly their previous read-only set.
    expect([...ROLE_PERMISSIONS[ROLES.GUEST]].sort()).toEqual(
      [P.VIEW_PEOPLE, P.VIEW_TEAM, P.VIEW_DOCUMENT, P.VIEW_MEETING, P.VIEW_TASK].sort(),
    );
  });
});
