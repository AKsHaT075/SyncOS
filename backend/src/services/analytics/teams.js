const mongoose = require('mongoose');
const { SCOPE_KIND, ANALYTICS_LIMITS } = require('../../constants/analytics.constants');
const Project = require('../../models/Project');
const Team = require('../../models/Team');
const { idOf, personNames, requireKind, run, table } = require('./common');
const { perPersonTaskStats } = require('./tasks');

/**
 * Team comparison. Task figures are "task assignments" of the team's members (a task assigned to two members of
 * the same team counts twice), restricted to tasks the actor may see.
 */
async function computeTeams(scope, range, filters = {}) {
  requireKind(scope, [SCOPE_KIND.ORGANIZATION, SCOPE_KIND.AGGREGATE, SCOPE_KIND.TEAM]);
  const teamFilter = {
    organization: scope.organization,
    ...(scope.ledTeamIds ? { _id: { $in: scope.ledTeamIds } } : {}),
    ...(filters.teamId ? { _id: filters.teamId } : {}),
  };
  const teams = await Team.find(teamFilter).select('name lead members').sort({ name: 1 }).limit(ANALYTICS_LIMITS.MAX_TEAMS).lean();
  const membersOf = (team) => [...new Set([team.lead, ...team.members].filter(Boolean).map(idOf))];
  const everyone = [...new Set(teams.flatMap(membersOf))];

  const [stats, projectCounts, leads] = await Promise.all([
    everyone.length ? perPersonTaskStats(scope, range, { ...filters, personIds: scope.personIds === null ? everyone.map((id) => new mongoose.Types.ObjectId(id)) : scope.personIds.filter((p) => everyone.includes(idOf(p))) }) : [],
    run(Project, [{ $match: { organization: scope.organization, deletedAt: null, archived: false, team: { $in: teams.map((team) => team._id) }, ...scope.projectMatch } }, { $group: { _id: '$team', count: { $sum: 1 } } }]),
    personNames(teams.map((team) => team.lead), scope.organization),
  ]);
  const byPerson = new Map(stats.map((row) => [idOf(row._id), row]));
  const projects = new Map(projectCounts.map((row) => [idOf(row._id), row.count]));

  const rows = teams.map((team) => {
    const members = membersOf(team);
    const totals = members.reduce((acc, id) => {
      const s = byPerson.get(id);
      if (s) { acc.open += s.open; acc.completed += s.completedInRange; acc.overdue += s.overdue; }
      return acc;
    }, { open: 0, completed: 0, overdue: 0 });
    return { id: idOf(team._id), team: team.name, lead: leads.get(idOf(team.lead)) || '', members: members.length, projects: projects.get(idOf(team._id)) || 0, ...totals };
  });

  return {
    kpis: {
      teams: rows.length,
      avgTeamSize: rows.length ? Number((rows.reduce((a, r) => a + r.members, 0) / rows.length).toFixed(1)) : null,
      largestTeam: rows.length ? Math.max(...rows.map((r) => r.members)) : null,
      totalOpen: rows.reduce((a, r) => a + r.open, 0), totalOverdue: rows.reduce((a, r) => a + r.overdue, 0),
    },
    series: {},
    breakdowns: {
      byTeam: rows.map((r) => ({ id: r.id, name: r.team, members: r.members, open: r.open, completed: r.completed, overdue: r.overdue, projects: r.projects })).slice(0, ANALYTICS_LIMITS.TOP_N * 2),
    },
    table: table(
      [{ key: 'team', label: 'Team' }, { key: 'lead', label: 'Lead' }, { key: 'members', label: 'Members', type: 'number' }, { key: 'projects', label: 'Projects', type: 'number' },
        { key: 'open', label: 'Open tasks', type: 'number' }, { key: 'completed', label: 'Completed in period', type: 'number' }, { key: 'overdue', label: 'Overdue', type: 'number' }],
      rows,
    ),
    notes: ['Task figures count assignments: a task assigned to two members of the same team counts twice for that team.', 'Project counts are active (non-archived) projects linked to the team.'],
  };
}

module.exports = { computeTeams };
