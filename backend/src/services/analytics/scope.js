const crypto = require('crypto');
const mongoose = require('mongoose');
const AppError = require('../../utils/app-error');
const { ROLES } = require('../../constants/roles');
const { ROLE_PERMISSIONS } = require('../../constants/rolePermissions');
const { PROJECT_MEMBER_ROLES } = require('../../constants/project.constants');
const { TASK_VISIBILITY } = require('../../constants/task.constants');
const { ANALYTICS_LIMITS, SCOPE_KIND } = require('../../constants/analytics.constants');
const { buildProjectVisibilityFilter } = require('../../utils/projectAccess');
const Project = require('../../models/Project');
const Team = require('../../models/Team');
const User = require('../../models/User');
const { resolveTimeZone } = require('../calendar.service');

const idOf = (value) => (value ? (value._id ? value._id.toString() : value.toString()) : null);
const oid = (value) => new mongoose.Types.ObjectId(String(value));
const sorted = (ids) => [...ids].map(idOf).sort();

const KIND_BY_ROLE = {
  [ROLES.ORG_ADMIN]: SCOPE_KIND.ORGANIZATION,
  [ROLES.ADMIN]: SCOPE_KIND.ORGANIZATION, // identical permissions to org-admin
  [ROLES.HR]: SCOPE_KIND.AGGREGATE,
  [ROLES.MANAGER]: SCOPE_KIND.TEAM,
  [ROLES.EMPLOYEE]: SCOPE_KIND.SELF,
};

/**
 * Everything an analytics query needs to know about WHO is asking and WHAT they may see, resolved once per request
 * from the existing access rules (never widened):
 *
 *  - `personIds`   people whose data may be reported on (null = everyone in the organization)
 *  - `taskMatch`   Mongo fragment that limits Tasks to ones the actor may see (mirrors listTasks/canViewTask)
 *  - `projectMatch` Mongo fragment that limits Projects to ones the actor may see
 *  - `details`     false for HR: counts only, never titles / project names / task content
 *  - `fingerprint` hash of the resolved scope. It is part of every cache key, so a role, team or project-membership
 *                  change produces a different key and can never serve another scope's cached numbers.
 */
async function resolveScope(actor, { timezone } = {}) {
  const kind = KIND_BY_ROLE[actor.role] ?? SCOPE_KIND.NONE;
  if (kind === SCOPE_KIND.NONE || !actor.organization) {
    throw new AppError('Analytics are not available for your role', 403, 'FORBIDDEN');
  }

  const organization = actor.organization;
  const { timeZone } = await resolveTimeZone(actor, timezone);
  const scope = {
    actor, organization, role: actor.role, kind, timeZone,
    permissions: ROLE_PERMISSIONS[actor.role] || [],
    details: kind !== SCOPE_KIND.AGGREGATE,
    personIds: null, ledTeamIds: null, visibleProjectIds: null, fullProjectIds: null,
    taskMatch: {}, projectMatch: {}, truncated: false,
  };

  if (kind === SCOPE_KIND.ORGANIZATION || kind === SCOPE_KIND.AGGREGATE) {
    scope.fingerprint = hash({ kind, role: actor.role, timeZone });
    return scope;
  }

  if (kind === SCOPE_KIND.SELF) {
    scope.personIds = [oid(actor._id)];
    scope.fingerprint = hash({ kind, user: idOf(actor._id), timeZone });
    return scope;
  }

  // ---- manager: led teams + the projects they can already see ----
  const [teams, visibleProjects] = await Promise.all([
    Team.find({ organization, lead: actor._id }).select('_id members').limit(ANALYTICS_LIMITS.MAX_TEAMS).lean(),
    Project.find({ organization, deletedAt: null, ...buildProjectVisibilityFilter(actor) })
      .select('_id owner members visibility team').limit(ANALYTICS_LIMITS.MAX_PROJECTS + 1).lean(),
  ]);
  if (visibleProjects.length > ANALYTICS_LIMITS.MAX_PROJECTS) {
    visibleProjects.length = ANALYTICS_LIMITS.MAX_PROJECTS;
    scope.truncated = true;
  }

  const people = new Set([idOf(actor._id)]);
  teams.forEach((team) => team.members.forEach((member) => people.add(idOf(member))));
  const ledTeamIds = teams.map((team) => idOf(team._id));
  scope.ledTeamIds = ledTeamIds.map(oid);
  scope.personIds = [...people].map(oid);

  const visible = visibleProjects.map((project) => idOf(project._id));
  // Projects the manager runs (owner / project Manager): they may see PRIVATE tasks there too.
  const full = visibleProjects
    .filter((project) => {
      if (idOf(project.owner) === idOf(actor._id)) return true;
      const member = project.members.find((entry) => idOf(entry.user) === idOf(actor._id));
      return member && [PROJECT_MEMBER_ROLES.OWNER, PROJECT_MEMBER_ROLES.MANAGER].includes(member.role);
    })
    .map((project) => idOf(project._id));
  scope.visibleProjectIds = visible.map(oid);
  scope.fullProjectIds = full.map(oid);

  // The projects that matter for a manager: those of their teams, or that they or their people belong to.
  const relevant = visibleProjects.filter((project) =>
    ledTeamIds.includes(idOf(project.team))
    || people.has(idOf(project.owner))
    || project.members.some((member) => people.has(idOf(member.user))));
  scope.projectMatch = { _id: { $in: relevant.map((project) => project._id) } };

  // Same rule as listTasks: public tasks of visible projects, private ones only where attached or running the project.
  scope.taskMatch = {
    $or: [
      { project: { $in: scope.fullProjectIds } },
      { project: { $in: scope.visibleProjectIds }, visibility: TASK_VISIBILITY.PUBLIC },
      { project: { $in: scope.visibleProjectIds }, assignees: actor._id },
      { project: { $in: scope.visibleProjectIds }, approvers: actor._id },
    ],
  };

  scope.fingerprint = hash({
    kind, role: actor.role, user: idOf(actor._id), timeZone, truncated: scope.truncated,
    teams: sorted(ledTeamIds), people: sorted(people), visible: sorted(visible), full: sorted(full),
  });
  return scope;
}

function hash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

/**
 * Validates optional team / person / project filters AGAINST the actor's scope and returns the effective
 * restrictions. A filter pointing outside the scope is a 404, never an empty-looking success that leaks existence.
 */
async function resolveFilters(scope, { teamId, userId, projectId } = {}) {
  const result = { personIds: scope.personIds, teamId: null, userId: null, projectId: null, team: null };
  if (!teamId && !userId && !projectId) return result;
  if (scope.kind === SCOPE_KIND.SELF) throw new AppError('Filters are not available for personal analytics', 403, 'FORBIDDEN');
  const inScope = (id) => scope.personIds === null || scope.personIds.some((p) => idOf(p) === idOf(id));
  const notFound = (what) => new AppError(`${what} not found`, 404, 'NOT_FOUND');

  if (teamId) {
    if (scope.ledTeamIds && !scope.ledTeamIds.some((t) => idOf(t) === teamId)) throw notFound('Team');
    const team = await Team.findOne({ _id: teamId, organization: scope.organization }).select('name lead members').lean();
    if (!team) throw notFound('Team');
    const members = [team.lead, ...team.members].filter(Boolean).map(idOf);
    const unique = [...new Set(members)].filter((id) => inScope(id)).map(oid);
    result.teamId = teamId;
    result.team = team;
    result.personIds = unique;
  }

  if (userId) {
    const user = await User.findOne({ _id: userId, organization: scope.organization }).select('_id').lean();
    if (!user || !inScope(user._id)) throw notFound('Person');
    if (result.personIds && !result.personIds.some((p) => idOf(p) === userId)) throw notFound('Person');
    result.userId = userId;
    result.personIds = [oid(userId)];
  }

  if (projectId) {
    // HR sees only aggregates: a per-project view would reveal project details they cannot otherwise access.
    if (!scope.details) throw new AppError('Project-level analytics are not available for your role', 403, 'FORBIDDEN');
    const project = await Project.findOne({ _id: projectId, organization: scope.organization, deletedAt: null }).select('_id').lean();
    if (!project) throw notFound('Project');
    if (scope.visibleProjectIds && !scope.visibleProjectIds.some((p) => idOf(p) === projectId)) throw notFound('Project');
    result.projectId = projectId;
  }
  return result;
}

module.exports = { idOf, oid, resolveFilters, resolveScope };
