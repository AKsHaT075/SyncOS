const mongoose = require('mongoose');
const canEditTask = require('../../src/utils/canEditTask');
const canDeleteProject = require('../../src/utils/canDeleteProject');
const canManageUsers = require('../../src/utils/canManageUsers');
const canAssignAssets = require('../../src/utils/canAssignAssets');
const { ROLES } = require('../../src/constants/roles');

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();

describe('canEditTask', () => {
  it('lets an employee edit a task assigned to them in their org', () => {
    const user = { _id: userId, organization: orgA, role: ROLES.EMPLOYEE };
    const task = { organization: orgA, assignedTo: userId };
    expect(canEditTask(user, task)).toBe(true);
  });

  it('blocks an employee from editing a task assigned to someone else', () => {
    const user = { _id: userId, organization: orgA, role: ROLES.EMPLOYEE };
    const task = { organization: orgA, assignedTo: otherUserId };
    expect(canEditTask(user, task)).toBe(false);
  });

  it('blocks access across organizations even for a manager', () => {
    const user = { _id: userId, organization: orgA, role: ROLES.MANAGER };
    const task = { organization: orgB, assignedTo: userId };
    expect(canEditTask(user, task)).toBe(false);
  });

  it('lets a manager edit any task in their own org', () => {
    const user = { _id: userId, organization: orgA, role: ROLES.MANAGER };
    const task = { organization: orgA, assignedTo: otherUserId };
    expect(canEditTask(user, task)).toBe(true);
  });
});

describe('canDeleteProject', () => {
  it('allows ORG_ADMIN and MANAGER within the org', () => {
    const project = { organization: orgA };
    expect(canDeleteProject({ organization: orgA, role: ROLES.ORG_ADMIN }, project)).toBe(true);
    expect(canDeleteProject({ organization: orgA, role: ROLES.MANAGER }, project)).toBe(true);
  });

  it('blocks HR and EMPLOYEE', () => {
    const project = { organization: orgA };
    expect(canDeleteProject({ organization: orgA, role: ROLES.HR }, project)).toBe(false);
    expect(canDeleteProject({ organization: orgA, role: ROLES.EMPLOYEE }, project)).toBe(false);
  });

  it('blocks cross-organization deletion', () => {
    const project = { organization: orgB };
    expect(canDeleteProject({ organization: orgA, role: ROLES.ORG_ADMIN }, project)).toBe(false);
  });
});

describe('canManageUsers', () => {
  it('lets ORG_ADMIN manage any user in the org', () => {
    const target = { organization: orgA, role: ROLES.MANAGER };
    expect(canManageUsers({ organization: orgA, role: ROLES.ORG_ADMIN }, target)).toBe(true);
  });

  it('lets HR manage only EMPLOYEE role users', () => {
    const employee = { organization: orgA, role: ROLES.EMPLOYEE };
    const manager = { organization: orgA, role: ROLES.MANAGER };
    expect(canManageUsers({ organization: orgA, role: ROLES.HR }, employee)).toBe(true);
    expect(canManageUsers({ organization: orgA, role: ROLES.HR }, manager)).toBe(false);
  });

  it('blocks cross-organization management', () => {
    const target = { organization: orgB, role: ROLES.EMPLOYEE };
    expect(canManageUsers({ organization: orgA, role: ROLES.ORG_ADMIN }, target)).toBe(false);
  });
});

describe('canAssignAssets', () => {
  it('allows ORG_ADMIN and MANAGER within the org', () => {
    const asset = { organization: orgA };
    expect(canAssignAssets({ organization: orgA, role: ROLES.ORG_ADMIN }, asset)).toBe(true);
    expect(canAssignAssets({ organization: orgA, role: ROLES.MANAGER }, asset)).toBe(true);
  });

  it('blocks everyone else and cross-org access', () => {
    const asset = { organization: orgA };
    expect(canAssignAssets({ organization: orgA, role: ROLES.EMPLOYEE }, asset)).toBe(false);
    expect(canAssignAssets({ organization: orgB, role: ROLES.ORG_ADMIN }, asset)).toBe(false);
  });
});
