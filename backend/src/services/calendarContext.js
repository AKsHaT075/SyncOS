const Project = require('../models/Project');
const Team = require('../models/Team');
const { PROJECT_MEMBER_ROLES } = require('../constants/project.constants');
const { buildCalendarContext, idOf, isOrgAdmin } = require('../utils/calendarAccess');

const PROJECT_FIELDS = 'name owner members team dueDate status archived visibility organization';

/**
 * The viewer's current team and project memberships — evaluated on every
 * request, so a membership change takes effect immediately.
 */
async function loadCalendarContext(user) {
  const organization = user.organization;
  const [teams, projects] = await Promise.all([
    Team.find({ organization, $or: [{ members: user._id }, { lead: user._id }] }).select('_id lead').lean(),
    Project.find({ organization, deletedAt: null, $or: [{ owner: user._id }, { 'members.user': user._id }] })
      .select(PROJECT_FIELDS)
      .lean(),
  ]);

  const managedProjectIds = projects
    .filter((project) => {
      if (idOf(project.owner) === user._id.toString()) return true;
      const member = project.members.find((entry) => idOf(entry.user) === user._id.toString());
      return member && [PROJECT_MEMBER_ROLES.OWNER, PROJECT_MEMBER_ROLES.MANAGER].includes(member.role);
    })
    .map((project) => idOf(project._id));

  const ctx = buildCalendarContext(user, {
    teamIds: teams.map((team) => idOf(team._id)),
    ledTeamIds: teams.filter((team) => idOf(team.lead) === user._id.toString()).map((team) => idOf(team._id)),
    projectIds: projects.map((project) => idOf(project._id)),
    managedProjectIds,
  });
  return { ctx, memberProjects: projects };
}

module.exports = { PROJECT_FIELDS, isOrgAdmin, loadCalendarContext };
