const { ROLES } = require('./roles');

const ASSET_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  ASSIGNED: 'ASSIGNED',
  UNDER_MAINTENANCE: 'UNDER_MAINTENANCE',
  RESERVED: 'RESERVED',
  RETIRED: 'RETIRED',
  DISPOSED: 'DISPOSED',
  LOST: 'LOST',
});

/**
 * Allowed lifecycle transitions. Status is NEVER set by a plain edit: every change goes through a named
 * action (assign / transfer / return / start-or-finish maintenance / reserve / retire / dispose / lost / found)
 * and each action is validated against this table.
 *
 * UNDER_MAINTENANCE returns to whatever the asset was before (ASSIGNED if it still has a holder, else AVAILABLE).
 */
const S = ASSET_STATUS;
const ASSET_TRANSITIONS = Object.freeze({
  [S.AVAILABLE]: [S.ASSIGNED, S.RESERVED, S.UNDER_MAINTENANCE, S.RETIRED, S.LOST],
  [S.RESERVED]: [S.AVAILABLE, S.ASSIGNED, S.UNDER_MAINTENANCE],
  [S.ASSIGNED]: [S.AVAILABLE, S.UNDER_MAINTENANCE, S.LOST],
  [S.UNDER_MAINTENANCE]: [S.AVAILABLE, S.ASSIGNED, S.RESERVED, S.RETIRED],
  [S.LOST]: [S.AVAILABLE, S.RETIRED],
  [S.RETIRED]: [S.DISPOSED],
  [S.DISPOSED]: [],
});

const ASSET_KIND = Object.freeze({ HARDWARE: 'hardware', SOFTWARE: 'software' });
const ASSET_CONDITION = Object.freeze({ NEW: 'NEW', GOOD: 'GOOD', FAIR: 'FAIR', POOR: 'POOR', DAMAGED: 'DAMAGED' });
const ASSIGNEE_TYPE = Object.freeze({ USER: 'user', TEAM: 'team' });

const ASSIGNMENT_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED',
  VOID: 'VOID', // an attempt that never took effect (e.g. the asset changed under it)
});
const CLOSE_REASON = Object.freeze({
  RETURNED: 'RETURNED',
  TRANSFERRED: 'TRANSFERRED',
  LOST: 'LOST', // the asset was reported lost while assigned
  RECONCILED: 'RECONCILED', // closed by the integrity repair, not by a person
});

const MAINTENANCE_STATUS = Object.freeze({
  REQUESTED: 'REQUESTED', // submitted by an employee, awaiting approval
  SCHEDULED: 'SCHEDULED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});
const M = MAINTENANCE_STATUS;
const MAINTENANCE_TRANSITIONS = Object.freeze({
  [M.REQUESTED]: [M.SCHEDULED, M.CANCELLED],
  [M.SCHEDULED]: [M.IN_PROGRESS, M.CANCELLED],
  [M.IN_PROGRESS]: [M.COMPLETED, M.CANCELLED],
  [M.COMPLETED]: [],
  [M.CANCELLED]: [],
});
const MAINTENANCE_TYPE = Object.freeze({ PREVENTIVE: 'PREVENTIVE', REPAIR: 'REPAIR', INSPECTION: 'INSPECTION', UPGRADE: 'UPGRADE', OTHER: 'OTHER' });

const LICENSE_TYPE = Object.freeze({ PERPETUAL: 'PERPETUAL', SUBSCRIPTION: 'SUBSCRIPTION', PER_SEAT: 'PER_SEAT', SITE: 'SITE', OPEN_SOURCE: 'OPEN_SOURCE' });

const DOCUMENT_KIND = Object.freeze({
  IMAGE: 'image',
  INVOICE: 'invoice',
  WARRANTY: 'warranty',
  MANUAL: 'manual',
  ASSIGNMENT_AGREEMENT: 'assignment_agreement',
  MAINTENANCE_REPORT: 'maintenance_report',
  OTHER: 'other',
});

const DEFAULT_CURRENCY = 'INR';
const CURRENCIES = Object.freeze(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY']);

const DEFAULT_CATEGORIES = Object.freeze([
  'Computers & Laptops', 'Monitors & Displays', 'Mobile Devices', 'Networking Equipment', 'Office Equipment',
  'Furniture', 'Printers & Scanners', 'Software & Licenses', 'Other',
]);

// Roles that see and act across the whole organization. Managers are scoped to teams they lead; everyone
// else only sees what they hold. (Capability comes from permissions; this only decides the DATA scope.)
const ASSET_ORG_WIDE_ROLES = Object.freeze([ROLES.ORG_ADMIN, ROLES.ADMIN, ROLES.HR]);
const ASSET_ADMIN_ROLES = Object.freeze([ROLES.ORG_ADMIN, ROLES.ADMIN]);

// Reminder thresholds, in days before the date.
const WARRANTY_ALERT_DAYS = Object.freeze([30, 7, 1]);
const LICENSE_ALERT_DAYS = Object.freeze([30, 7, 1]);
const MAINTENANCE_UPCOMING_DAYS = 30;

const LIMITS = Object.freeze({ STATUS_HISTORY: 100, PAGE_MAX: 100, EXPORT_MAX: 5000, MAX_SEATS: 1000000 });

module.exports = {
  ASSET_ADMIN_ROLES,
  ASSET_CONDITION,
  ASSET_KIND,
  ASSET_ORG_WIDE_ROLES,
  ASSET_STATUS,
  ASSET_TRANSITIONS,
  ASSIGNEE_TYPE,
  ASSIGNMENT_STATUS,
  CLOSE_REASON,
  CURRENCIES,
  DEFAULT_CATEGORIES,
  DEFAULT_CURRENCY,
  DOCUMENT_KIND,
  LICENSE_ALERT_DAYS,
  LICENSE_TYPE,
  LIMITS,
  MAINTENANCE_STATUS,
  MAINTENANCE_TRANSITIONS,
  MAINTENANCE_TYPE,
  MAINTENANCE_UPCOMING_DAYS,
  WARRANTY_ALERT_DAYS,
};
