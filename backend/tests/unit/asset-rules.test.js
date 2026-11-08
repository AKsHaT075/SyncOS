const mongoose = require('mongoose');
const {
  ASSET_STATUS, ASSET_TRANSITIONS, MAINTENANCE_STATUS, MAINTENANCE_TRANSITIONS, WARRANTY_ALERT_DAYS,
} = require('../../src/constants/asset.constants');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { ROLE_PERMISSIONS } = require('../../src/constants/rolePermissions');
const { ROLES } = require('../../src/constants/roles');
const {
  buildAssetContext, buildAssetVisibilityFilter, canAssignTo, canReportIssue, canReturnFrom, canTransferTo, canViewAsset,
} = require('../../src/utils/assetAccess');
const { thresholdFor } = require('../../src/services/assetJobs');
const { csvCell } = require('../../src/services/assetReports.service');

const id = () => new mongoose.Types.ObjectId();
const org = id();

describe('lifecycle table', () => {
  it('lists exactly the transitions agreed for the product', () => {
    expect(ASSET_TRANSITIONS.AVAILABLE).toEqual(expect.arrayContaining(['ASSIGNED', 'RESERVED', 'UNDER_MAINTENANCE', 'RETIRED', 'LOST']));
    expect(ASSET_TRANSITIONS.ASSIGNED).toEqual(expect.arrayContaining(['AVAILABLE', 'UNDER_MAINTENANCE', 'LOST']));
    expect(ASSET_TRANSITIONS.UNDER_MAINTENANCE).toContain('AVAILABLE');
    expect(ASSET_TRANSITIONS.RETIRED).toEqual(['DISPOSED']);
  });

  it('DISPOSED is final, and nothing jumps to DISPOSED except from RETIRED', () => {
    expect(ASSET_TRANSITIONS.DISPOSED).toEqual([]);
    Object.entries(ASSET_TRANSITIONS).forEach(([from, targets]) => {
      if (targets.includes(ASSET_STATUS.DISPOSED)) expect(from).toBe(ASSET_STATUS.RETIRED);
    });
  });

  it('a held asset cannot be retired or disposed directly, and retired assets cannot be assigned', () => {
    expect(ASSET_TRANSITIONS.ASSIGNED).not.toContain('RETIRED');
    expect(ASSET_TRANSITIONS.ASSIGNED).not.toContain('DISPOSED');
    expect(ASSET_TRANSITIONS.RETIRED).not.toContain('ASSIGNED');
    expect(ASSET_TRANSITIONS.LOST).not.toContain('ASSIGNED');
  });

  it('every status is a valid target of the table (no typos)', () => {
    const all = new Set(Object.values(ASSET_STATUS));
    Object.entries(ASSET_TRANSITIONS).forEach(([from, targets]) => {
      expect(all.has(from)).toBe(true);
      targets.forEach((to) => expect(all.has(to)).toBe(true));
    });
  });

  it('maintenance moves REQUESTED → SCHEDULED → IN_PROGRESS → COMPLETED, with cancellation, and finished records are final', () => {
    const M = MAINTENANCE_STATUS;
    expect(MAINTENANCE_TRANSITIONS[M.REQUESTED]).toEqual([M.SCHEDULED, M.CANCELLED]);
    expect(MAINTENANCE_TRANSITIONS[M.SCHEDULED]).toEqual([M.IN_PROGRESS, M.CANCELLED]);
    expect(MAINTENANCE_TRANSITIONS[M.IN_PROGRESS]).toEqual([M.COMPLETED, M.CANCELLED]);
    expect(MAINTENANCE_TRANSITIONS[M.COMPLETED]).toEqual([]);
    expect(MAINTENANCE_TRANSITIONS[M.CANCELLED]).toEqual([]);
  });
});

describe('role permissions', () => {
  const has = (role, permission) => ROLE_PERMISSIONS[role].includes(permission);

  it('follows the approved matrix', () => {
    [ROLES.ORG_ADMIN, ROLES.ADMIN].forEach((role) => {
      ['VIEW_ASSETS', 'CREATE_ASSET', 'UPDATE_ASSET', 'DELETE_ASSET', 'ASSIGN_ASSET', 'TRANSFER_ASSET', 'RETURN_ASSET', 'MANAGE_ASSET_CATEGORIES',
        'MANAGE_ASSET_MAINTENANCE', 'MANAGE_ASSET_LICENSES', 'VIEW_ASSET_REPORTS', 'MANAGE_ASSET_VENDORS', 'VIEW_OWN_ASSETS'].forEach((p) => expect(has(role, p)).toBe(true));
    });
    ['VIEW_ASSETS', 'ASSIGN_ASSET', 'TRANSFER_ASSET', 'RETURN_ASSET', 'VIEW_ASSET_REPORTS', 'MANAGE_ASSET_VENDORS'].forEach((p) => expect(has(ROLES.HR, p)).toBe(true));
    ['CREATE_ASSET', 'UPDATE_ASSET', 'DELETE_ASSET', 'MANAGE_ASSET_MAINTENANCE', 'MANAGE_ASSET_LICENSES', 'MANAGE_ASSET_CATEGORIES'].forEach((p) => expect(has(ROLES.HR, p)).toBe(false));
    ['VIEW_ASSETS', 'ASSIGN_ASSET', 'TRANSFER_ASSET', 'RETURN_ASSET'].forEach((p) => expect(has(ROLES.MANAGER, p)).toBe(true));
    ['CREATE_ASSET', 'UPDATE_ASSET', 'DELETE_ASSET', 'VIEW_ASSET_REPORTS', 'MANAGE_ASSET_VENDORS'].forEach((p) => expect(has(ROLES.MANAGER, p)).toBe(false));
    expect(ROLE_PERMISSIONS[ROLES.EMPLOYEE].filter((p) => /ASSET/.test(p))).toEqual(['VIEW_OWN_ASSETS']);
    expect(ROLE_PERMISSIONS[ROLES.GUEST].filter((p) => /ASSET/.test(p))).toEqual([]);
  });

  it('keeps the legacy MANAGE_ASSETS permission for the roles that had it', () => {
    expect(has(ROLES.ORG_ADMIN, PERMISSIONS.MANAGE_ASSETS)).toBe(true);
    expect(has(ROLES.MANAGER, PERMISSIONS.MANAGE_ASSETS)).toBe(true);
    expect(has(ROLES.EMPLOYEE, PERMISSIONS.MANAGE_ASSETS)).toBe(false);
  });
});

describe('asset data scope', () => {
  const ledTeam = id();
  const otherTeam = id();
  const manager = { _id: id(), organization: org, role: ROLES.MANAGER };
  const hr = { _id: id(), organization: org, role: ROLES.HR };
  const employee = { _id: id(), organization: org, role: ROLES.EMPLOYEE };
  const guest = { _id: id(), organization: org, role: ROLES.GUEST };
  const reportee = id();
  const stranger = id();

  const managerCtx = buildAssetContext(manager, { teamIds: [ledTeam], ledTeamIds: [ledTeam], ledMemberIds: [reportee] });
  const employeeCtx = (held = [], teams = []) => buildAssetContext(employee, { teamIds: teams, heldAssetIds: held });
  const asset = (over = {}) => ({ _id: id(), organization: org, status: 'ASSIGNED', team: null, assignedUser: null, assignedTeam: null, ...over });

  it('org-wide roles see everything in their organization, and nothing in another', () => {
    const ctx = buildAssetContext(hr);
    expect(canViewAsset(ctx, asset())).toBe(true);
    expect(canViewAsset(ctx, asset({ organization: id() }))).toBe(false);
    expect(buildAssetVisibilityFilter(ctx)).toEqual({});
  });

  it('managers see only people and teams they lead, plus the pool they can assign from', () => {
    expect(canViewAsset(managerCtx, asset({ assignedUser: reportee }))).toBe(true);
    expect(canViewAsset(managerCtx, asset({ assignedUser: stranger }))).toBe(false);
    expect(canViewAsset(managerCtx, asset({ team: ledTeam }))).toBe(true);
    expect(canViewAsset(managerCtx, asset({ team: otherTeam }))).toBe(false);
    expect(canViewAsset(managerCtx, asset({ status: 'AVAILABLE', team: null }))).toBe(true); // assignable pool
    expect(canViewAsset(managerCtx, asset({ status: 'AVAILABLE', team: otherTeam }))).toBe(false);
    expect(canViewAsset(managerCtx, asset({ status: 'RETIRED', team: null }))).toBe(false);
  });

  it('employees see only what they hold; guests nothing', () => {
    const mine = asset();
    expect(canViewAsset(employeeCtx([mine._id.toString()]), mine)).toBe(true);
    expect(canViewAsset(employeeCtx(), mine)).toBe(false);
    const teamHeld = asset({ assignedTeam: ledTeam });
    expect(canViewAsset(employeeCtx([], [ledTeam.toString()]), teamHeld)).toBe(true);
    expect(canViewAsset(buildAssetContext(guest, { heldAssetIds: [mine._id.toString()] }), mine)).toBe(false);
    expect(buildAssetVisibilityFilter(buildAssetContext(guest))).toEqual({ _id: { $in: [] } });
  });

  it('managers may assign only to people/teams they lead, from the pool; HR to anyone', () => {
    const pool = asset({ status: 'AVAILABLE' });
    expect(canAssignTo(managerCtx, pool, { user: reportee })).toBe(true);
    expect(canAssignTo(managerCtx, pool, { team: ledTeam })).toBe(true);
    expect(canAssignTo(managerCtx, pool, { user: stranger })).toBe(false);
    expect(canAssignTo(managerCtx, asset({ status: 'AVAILABLE', team: otherTeam }), { user: reportee })).toBe(false);
    expect(canAssignTo(buildAssetContext(hr), pool, { user: stranger })).toBe(true);
    expect(canAssignTo(employeeCtx(), pool, { user: employee._id })).toBe(false); // no ASSIGN_ASSET
  });

  it('transfers and returns follow the same scope', () => {
    const held = asset({ assignedUser: reportee });
    expect(canTransferTo(managerCtx, held, { user: reportee }, { user: managerCtx.user._id })).toBe(true);
    expect(canTransferTo(managerCtx, held, { user: reportee }, { user: stranger })).toBe(false);
    expect(canTransferTo(managerCtx, held, { user: stranger }, { user: reportee })).toBe(false);
    expect(canReturnFrom(managerCtx, held, { user: reportee })).toBe(true);
    expect(canReturnFrom(managerCtx, held, { user: stranger })).toBe(false);
    expect(canReturnFrom(buildAssetContext(hr), held, { user: stranger })).toBe(true);
    expect(canReturnFrom(employeeCtx([held._id.toString()]), held, { user: employee._id })).toBe(false); // employees can't return
  });

  it('employees may report problems only with equipment they hold', () => {
    const mine = asset();
    expect(canReportIssue(employeeCtx([mine._id.toString()]), mine)).toBe(true);
    expect(canReportIssue(employeeCtx(), mine)).toBe(false);
  });
});

describe('alert thresholds', () => {
  it('picks the smallest threshold that covers the days left, so alerts step 30 → 7 → 1', () => {
    const t = (days) => thresholdFor(days, WARRANTY_ALERT_DAYS);
    expect(t(45)).toBeNull();
    expect(t(30)).toBe(30);
    expect(t(25)).toBe(30);
    expect(t(8)).toBe(30);
    expect(t(7)).toBe(7);
    expect(t(2)).toBe(7);
    expect(t(1)).toBe(1);
    expect(t(0)).toBe(1);
  });
});

describe('CSV export safety', () => {
  it('neutralises spreadsheet formulas and quotes special characters', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('Laptop, 15"')).toBe('"Laptop, 15"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(1500)).toBe('1500');
  });
});
