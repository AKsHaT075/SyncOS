const authorize = require('../../src/middlewares/authorize');
const checkPermission = require('../../src/middlewares/checkPermission');
const { ROLES } = require('../../src/constants/roles');
const { PERMISSIONS } = require('../../src/constants/permissions');

function mockRes() {
  return {};
}

describe('authorize middleware', () => {
  it('rejects unauthenticated requests', () => {
    const next = jest.fn();
    authorize(ROLES.ORG_ADMIN)({ user: null }, mockRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
  });

  it('rejects a role not in the allow-list', () => {
    const next = jest.fn();
    authorize(ROLES.ORG_ADMIN)({ user: { role: ROLES.EMPLOYEE } }, mockRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('allows a role in the allow-list', () => {
    const next = jest.fn();
    authorize(ROLES.ORG_ADMIN, ROLES.HR)({ user: { role: ROLES.HR } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('checkPermission middleware', () => {
  it('rejects unauthenticated requests', () => {
    const next = jest.fn();
    checkPermission(PERMISSIONS.MANAGE_USERS)({ user: null }, mockRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
  });

  it('rejects a role without the permission', () => {
    const next = jest.fn();
    checkPermission(PERMISSIONS.MANAGE_USERS)({ user: { role: ROLES.EMPLOYEE } }, mockRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('allows a role with the permission', () => {
    const next = jest.fn();
    checkPermission(PERMISSIONS.MANAGE_USERS)({ user: { role: ROLES.ORG_ADMIN } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('GUEST has no write permissions', () => {
    const next = jest.fn();
    checkPermission(PERMISSIONS.UPDATE_TASK)({ user: { role: ROLES.GUEST } }, mockRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  });

  it('GUEST can view tasks/documents/meetings', () => {
    [PERMISSIONS.VIEW_TASK, PERMISSIONS.VIEW_DOCUMENT, PERMISSIONS.VIEW_MEETING].forEach((permission) => {
      const next = jest.fn();
      checkPermission(permission)({ user: { role: ROLES.GUEST } }, mockRes(), next);
      expect(next).toHaveBeenCalledWith();
    });
  });

  it('SUPER_ADMIN has no implicit org-data permissions', () => {
    const next = jest.fn();
    checkPermission(PERMISSIONS.MANAGE_USERS)({ user: { role: ROLES.SUPER_ADMIN } }, mockRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  });
});
