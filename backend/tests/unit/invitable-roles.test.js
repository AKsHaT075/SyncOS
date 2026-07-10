const { getInvitableRoles } = require('../../src/services/invitation.service');
const { ROLES } = require('../../src/constants/roles');

describe('getInvitableRoles', () => {
  it('lets ORG_ADMIN invite into ADMIN, HR, MANAGER, and EMPLOYEE', () => {
    expect(getInvitableRoles(ROLES.ORG_ADMIN)).toEqual(
      expect.arrayContaining([ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE])
    );
  });

  it('blocks ADMIN from inviting another ADMIN', () => {
    const invitable = getInvitableRoles(ROLES.ADMIN);
    expect(invitable).not.toContain(ROLES.ADMIN);
    expect(invitable).toEqual(expect.arrayContaining([ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE]));
  });
});
