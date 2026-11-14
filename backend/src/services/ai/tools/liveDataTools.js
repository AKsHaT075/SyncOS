const { findTool, registerTool } = require('../aiToolRegistry');
const { createListMyScheduleTool } = require('./listMySchedule.tool');
const { createListMyTasksTool } = require('./listMyTasks.tool');
const { createGetProjectOverviewTool } = require('./getProjectOverview.tool');
const { createGetTeamTool } = require('./getTeam.tool');
const { createGetWorkloadSummaryTool } = require('./getWorkloadSummary.tool');
const { createListProjectMembersTool } = require('./listProjectMembers.tool');
const { createListProjectTasksTool } = require('./listProjectTasks.tool');
const { createListProjectsTool } = require('./listProjects.tool');

/**
 * The live-data tool catalog. Exactly EIGHT tools exist so far; more stay unbuilt until approved.
 *   Step 3: list_my_tasks, list_my_schedule
 *   Step 4: list_projects, get_project_overview, list_project_members, list_project_tasks, get_team
 *   Step 5: get_workload_summary
 * Registration is explicit (called once at server start, and by tests): merely requiring the registry still yields an empty one.
 * A registered tool does nothing by itself: it runs only through the callback gate, only for a request that has an open tool
 * budget, and only while the organization has live data switched on.
 */
const TOOL_FACTORIES = Object.freeze([
  createListMyTasksTool, createListMyScheduleTool,
  createListProjectsTool, createGetProjectOverviewTool, createListProjectMembersTool, createListProjectTasksTool, createGetTeamTool,
  createGetWorkloadSummaryTool,
]);

/** Idempotent. `options.now` (a clock function) exists for tests. */
function registerLiveDataTools(options = {}) {
  for (const factory of TOOL_FACTORIES) {
    const definition = factory(options);
    if (!findTool(definition.name)) registerTool(definition);
  }
}

const STEP3_TOOL_NAMES = Object.freeze(['list_my_tasks', 'list_my_schedule']);
const STEP4_TOOL_NAMES = Object.freeze(['list_projects', 'get_project_overview', 'list_project_members', 'list_project_tasks', 'get_team']);
const STEP5_TOOL_NAMES = Object.freeze(['get_workload_summary']);
const LIVE_DATA_TOOL_NAMES = Object.freeze([...STEP3_TOOL_NAMES, ...STEP4_TOOL_NAMES, ...STEP5_TOOL_NAMES]);

module.exports = { LIVE_DATA_TOOL_NAMES, STEP3_TOOL_NAMES, STEP4_TOOL_NAMES, STEP5_TOOL_NAMES, registerLiveDataTools };
