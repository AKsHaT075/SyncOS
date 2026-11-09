const { SCOPE_KIND, ANALYTICS_LIMITS } = require('../../constants/analytics.constants');
const Meeting = require('../../models/Meeting');
const Team = require('../../models/Team');
const User = require('../../models/User');
const { fullName, idOf, requireKind, run, table } = require('./common');
const { meetingMatch } = require('./meetings');
const { perPersonTaskStats } = require('./tasks');

/**
 * People analytics. Workload and participation COUNTS per person: no scores, rankings or "performance" ratings.
 * Everyone listed is someone the actor may already see in the people directory; only counts come from tasks.
 */
async function computePeople(scope, range, filters = {}) {
  requireKind(scope, [SCOPE_KIND.ORGANIZATION, SCOPE_KIND.AGGREGATE, SCOPE_KIND.TEAM]);
  const personFilter = filters.personIds ? { _id: { $in: filters.personIds } } : {};
  const base = { organization: scope.organization, ...personFilter };

  const [members, blocked, newInRange, byRole, teams] = await Promise.all([
    User.find({ ...base, isActive: true, orgBlocked: { $ne: true } }).select('firstName lastName role createdAt').sort({ firstName: 1 }).limit(ANALYTICS_LIMITS.MAX_PEOPLE).lean(),
    User.countDocuments({ ...base, orgBlocked: true }),
    User.countDocuments({ ...base, createdAt: { $gte: range.start, $lt: range.end } }),
    run(User, [{ $match: { ...base, isActive: true, orgBlocked: { $ne: true } } }, { $group: { _id: '$role', count: { $sum: 1 } } }]),
    Team.find({ organization: scope.organization, ...(scope.ledTeamIds ? { _id: { $in: scope.ledTeamIds } } : {}) }).select('name lead members').limit(ANALYTICS_LIMITS.MAX_TEAMS).lean(),
  ]);

  const memberIds = members.map((member) => member._id);
  const peopleFilters = { ...filters, personIds: memberIds.length ? memberIds : [] };
  const [taskStats, participation] = await Promise.all([
    memberIds.length ? perPersonTaskStats(scope, range, peopleFilters) : [],
    memberIds.length ? run(Meeting, [
      { $match: meetingMatch(scope, range, filters) }, { $unwind: '$participants' }, { $match: { 'participants.user': { $in: memberIds } } },
      { $group: { _id: '$participants.user', invited: { $sum: 1 }, attended: { $sum: { $cond: [{ $ne: ['$participants.joinedAt', null] }, 1, 0] } } } },
    ]) : [],
  ]);
  const stats = new Map(taskStats.map((row) => [idOf(row._id), row]));
  const meet = new Map(participation.map((row) => [idOf(row._id), row]));
  const teamNames = new Map();
  teams.forEach((team) => [team.lead, ...team.members].filter(Boolean).forEach((member) => {
    const key = idOf(member);
    teamNames.set(key, [...new Set([...(teamNames.get(key) || []), team.name])]);
  }));

  const rows = members.map((member) => {
    const t = stats.get(idOf(member._id)) || { assigned: 0, open: 0, completedInRange: 0, overdue: 0 };
    const m = meet.get(idOf(member._id)) || { invited: 0, attended: 0 };
    return {
      id: idOf(member._id), person: fullName(member), role: member.role, teams: (teamNames.get(idOf(member._id)) || []).join(', '),
      assigned: t.assigned, open: t.open, completed: t.completedInRange, overdue: t.overdue, meetingsInvited: m.invited, meetingsAttended: m.attended,
    };
  }).sort((a, b) => b.open - a.open || a.person.localeCompare(b.person));

  const withWork = rows.filter((row) => row.open > 0);
  const teamMembership = new Map();
  teams.forEach((team) => new Set([team.lead, ...team.members].filter(Boolean).map(idOf)).forEach(() => teamMembership.set(idOf(team._id), (teamMembership.get(idOf(team._id)) || 0) + 1)));

  return {
    kpis: {
      members: members.length, blocked, newInRange,
      withOpenTasks: withWork.length, totalOpen: rows.reduce((a, r) => a + r.open, 0), totalOverdue: rows.reduce((a, r) => a + r.overdue, 0),
      avgOpenPerPerson: members.length ? Number((rows.reduce((a, r) => a + r.open, 0) / members.length).toFixed(1)) : null,
    },
    series: {},
    breakdowns: {
      byRole: byRole.map((row) => ({ key: row._id, count: row.count })),
      byTeam: teams.map((team) => ({ id: idOf(team._id), name: team.name, count: new Set([team.lead, ...team.members].filter(Boolean).map(idOf)).size })).sort((a, b) => b.count - a.count).slice(0, ANALYTICS_LIMITS.TOP_N),
      workload: rows.slice(0, ANALYTICS_LIMITS.TOP_N).map((row) => ({ id: row.id, name: row.person, open: row.open, overdue: row.overdue, completed: row.completed })),
    },
    table: table(
      [{ key: 'person', label: 'Person' }, { key: 'role', label: 'Role' }, { key: 'teams', label: 'Teams' }, { key: 'assigned', label: 'Assigned', type: 'number' }, { key: 'open', label: 'Open', type: 'number' },
        { key: 'completed', label: 'Completed in period', type: 'number' }, { key: 'overdue', label: 'Overdue', type: 'number' },
        { key: 'meetingsInvited', label: 'Meetings invited', type: 'number' }, { key: 'meetingsAttended', label: 'Meetings joined', type: 'number' }],
      rows,
    ),
    notes: [
      'These are workload and participation counts, not performance ratings: they do not account for task size, difficulty or work done outside the app.',
      'Completed counts tasks whose recorded completion date falls in the selected period.',
      ...(scope.kind === SCOPE_KIND.AGGREGATE ? ['Task figures are counts only. Task titles and project details are not shown.'] : []),
    ],
  };
}

module.exports = { computePeople };
