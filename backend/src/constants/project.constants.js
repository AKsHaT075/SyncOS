const PROJECT_STATUS = Object.freeze({
  PLANNING: 'Planning',
  ACTIVE: 'Active',
  ON_HOLD: 'On Hold',
  COMPLETED: 'Completed',
  ARCHIVED: 'Archived',
});

const PROJECT_PRIORITY = Object.freeze({
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
});

const PROJECT_VISIBILITY = Object.freeze({
  PRIVATE: 'Private',
  TEAM: 'Team',
  ORGANIZATION: 'Organization',
});

const PROJECT_TYPE = Object.freeze({
  TECHNICAL: 'Technical',
  DESIGN: 'Design',
  MARKETING: 'Marketing',
  OPERATIONS: 'Operations',
  RESEARCH: 'Research',
  OTHER: 'Other',
});

const PROJECT_MEMBER_ROLES = Object.freeze({
  OWNER: 'Owner',
  MANAGER: 'Manager',
  CONTRIBUTOR: 'Contributor',
  VIEWER: 'Viewer',
});

/**
 * Manual status edits only move between the "working" states. ARCHIVED is
 * never a valid manual target — it's only reachable via the archive action,
 * which snapshots the prior status (see Project.statusBeforeArchive) so
 * restore can put it back.
 */
const STATUS_TRANSITIONS = Object.freeze({
  [PROJECT_STATUS.PLANNING]: [PROJECT_STATUS.ACTIVE],
  [PROJECT_STATUS.ACTIVE]: [PROJECT_STATUS.ON_HOLD, PROJECT_STATUS.COMPLETED],
  [PROJECT_STATUS.ON_HOLD]: [PROJECT_STATUS.ACTIVE],
  [PROJECT_STATUS.COMPLETED]: [PROJECT_STATUS.ACTIVE],
  [PROJECT_STATUS.ARCHIVED]: [],
});

module.exports = {
  PROJECT_STATUS,
  PROJECT_PRIORITY,
  PROJECT_VISIBILITY,
  PROJECT_TYPE,
  PROJECT_MEMBER_ROLES,
  STATUS_TRANSITIONS,
};
