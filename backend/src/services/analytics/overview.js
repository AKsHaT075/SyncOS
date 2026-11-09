const { PERMISSIONS } = require('../../constants/permissions');
const { SCOPE_KIND } = require('../../constants/analytics.constants');
const AuditLog = require('../../models/AuditLog');
const { bucketExpr, denseSeries } = require('../../utils/analyticsRange');
const { computeAssets } = require('./assets');
const { computeMeetings } = require('./meetings');
const { computePeople } = require('./people');
const { computePersonal } = require('./personal');
const { computeProjects } = require('./projects');
const { computeTasks } = require('./tasks');
const { run } = require('./common');

const withoutTable = ({ table, ...rest }) => rest; // eslint-disable-line no-unused-vars

/**
 * The dashboard summary. It is assembled from the SAME domain calculations the detailed reports and CSV exports
 * use, so a number can never differ between the overview, a report and an export.
 */
async function computeOverview(scope, range, filters = {}) {
  if (scope.kind === SCOPE_KIND.SELF) return { mode: 'personal', ...await computePersonal(scope, range) };

  const wantsAssets = scope.permissions.includes(PERMISSIONS.VIEW_ASSETS);
  const [tasks, projects, meetings, people, assets, activity] = await Promise.all([
    computeTasks(scope, range, filters),
    computeProjects(scope, range, filters),
    computeMeetings(scope, range, filters),
    computePeople(scope, range, filters),
    wantsAssets ? computeAssets(scope, range, filters) : null,
    run(AuditLog, [
      { $match: { organization: scope.organization, createdAt: { $gte: range.start, $lt: range.end }, ...(scope.kind === SCOPE_KIND.TEAM ? { user: { $in: scope.personIds } } : {}) } },
      { $group: { _id: bucketExpr('$createdAt', range), actions: { $sum: 1 } } },
    ]),
  ]);

  return {
    mode: scope.kind,
    sections: {
      tasks: withoutTable(tasks), projects: withoutTable(projects), meetings: withoutTable(meetings), people: withoutTable(people),
      ...(assets ? { assets: withoutTable(assets) } : {}),
    },
    series: { activity: denseSeries(activity, range, ['actions']) },
    notes: [...new Set([...tasks.notes, ...projects.notes.slice(0, 1)])],
  };
}

module.exports = { computeOverview, withoutTable };
