/**
 * What the assistant is doing while it looks something up. The ONLY source of text is this fixed table: nothing that comes from
 * the network is ever displayed, only used as a KEY into it. Node forwards `{ type: "tool_activity", tool }` (exactly two fields,
 * `tool` one of these eight names); this file re-checks that shape and ignores anything else. It decides nothing about permissions.
 */
export const TOOL_ACTIVITY_LABELS = Object.freeze({
  list_my_tasks: "Checking your tasks",
  list_my_schedule: "Reviewing your schedule",
  list_projects: "Finding your projects",
  get_project_overview: "Reviewing project details",
  list_project_members: "Checking project members",
  list_project_tasks: "Reviewing project tasks",
  get_team: "Looking up team information",
  get_workload_summary: "Preparing workload summary",
});

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Validates one SSE event. `name` is the `event:` line, `data` the parsed JSON. Returns `{ tool, label }` for a valid event,
 * otherwise null (the caller ignores it: nothing is rendered, nothing throws).
 */
export function parseToolActivity(name, data) {
  if (name !== "tool_activity" || !isPlainObject(data)) return null;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes("type") || !keys.includes("tool")) return null;
  if (data.type !== "tool_activity" || typeof data.tool !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(TOOL_ACTIVITY_LABELS, data.tool)) return null; // also rejects "constructor", "__proto__", ...
  return { tool: data.tool, label: TOOL_ACTIVITY_LABELS[data.tool] };
}
