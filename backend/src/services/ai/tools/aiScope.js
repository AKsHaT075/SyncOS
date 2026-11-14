const mongoose = require('mongoose');
const Meeting = require('../../../models/Meeting');
const Project = require('../../../models/Project');
const Task = require('../../../models/Task');
const Team = require('../../../models/Team');
const User = require('../../../models/User');
const {
  buildAiPeopleFilter, buildAiProjectFilter, buildAiTeamFilter, canAiViewMeeting, canAiViewPerson, canAiViewProject, canAiViewTask, canAiViewTeam, classifyProjects,
} = require('../../../utils/aiAccess');

/**
 * Database-backed side of AI visibility: resolves WHICH projects a user can see, and loads single records by id with the AI
 * rules applied.
 *
 * Every `find*` returns the record or `null`, and `null` is the ONLY signal: a malformed id, an id that does not exist, an id in
 * another organization, and a record the user may not see are indistinguishable to the caller (and therefore to the model).
 * Identity and organization come from `actor` (the freshly loaded user) only.
 *
 * `maxTimeMs` is applied to every query (maxTimeMS), so a tool's deadline reaches the database.
 */

const MAX_PROJECTS = 2000; // a user who can see more than this gets the first MAX_PROJECTS and `truncated: true` (never an unbounded $in)

const valid = (id) => typeof id === 'string' ? mongoose.isValidObjectId(id) && /^[a-f0-9]{24}$/i.test(id) : mongoose.isValidObjectId(id);
const timed = (query, maxTimeMs) => (maxTimeMs ? query.maxTimeMS(maxTimeMs) : query);

/** The projects the user can see through AI, as the id sets the task / meeting filters need. */
async function resolveAiScope(actor, { maxTimeMs, includeArchived = false } = {}) {
  const rows = await timed(
    Project.find(buildAiProjectFilter(actor, { includeArchived })).select('_id organization owner members visibility team archived deletedAt').limit(MAX_PROJECTS + 1).lean(),
    maxTimeMs,
  );
  const truncated = rows.length > MAX_PROJECTS;
  if (truncated) rows.length = MAX_PROJECTS;
  return { ...classifyProjects(actor, rows), truncated };
}

async function findAiProject(actor, projectId, { maxTimeMs, includeArchived = false } = {}) {
  if (!valid(projectId)) return null;
  const project = await timed(Project.findOne({ _id: projectId, ...buildAiProjectFilter(actor, { includeArchived }) }).lean(), maxTimeMs);
  return project && canAiViewProject(actor, project, { includeArchived }) ? project : null;
}

/** A task, reachable only through a project the user can see. Returns { task, project } or null. */
async function findAiTask(actor, taskId, { maxTimeMs } = {}) {
  if (!valid(taskId) || !actor?.organization) return null;
  const task = await timed(Task.findOne({ _id: taskId, organization: actor.organization, deletedAt: null, archived: false }).lean(), maxTimeMs);
  if (!task) return null;
  const project = await findAiProject(actor, task.project, { maxTimeMs });
  return project && canAiViewTask(actor, project, task) ? { task, project } : null;
}

async function findAiMeeting(actor, meetingId, { maxTimeMs } = {}) {
  if (!valid(meetingId) || !actor?.organization) return null;
  const meeting = await timed(Meeting.findOne({ _id: meetingId, organization: actor.organization, deletedAt: null }).lean(), maxTimeMs);
  if (!meeting) return null;
  const project = await findAiProject(actor, meeting.project, { maxTimeMs });
  return project && canAiViewMeeting(actor, project, meeting) ? { meeting, project } : null;
}

async function findAiTeam(actor, teamId, { maxTimeMs } = {}) {
  if (!valid(teamId)) return null;
  const team = await timed(Team.findOne({ _id: teamId, ...buildAiTeamFilter(actor) }).lean(), maxTimeMs);
  return team && canAiViewTeam(actor, team) ? team : null;
}

async function findAiPerson(actor, userId, { maxTimeMs } = {}) {
  if (!valid(userId)) return null;
  const person = await timed(User.findOne({ _id: userId, ...buildAiPeopleFilter(actor) }).select('_id organization firstName lastName role team isActive orgBlocked').lean(), maxTimeMs);
  return person && canAiViewPerson(actor, person) ? person : null;
}

module.exports = { MAX_PROJECTS, findAiMeeting, findAiPerson, findAiProject, findAiTask, findAiTeam, resolveAiScope };
