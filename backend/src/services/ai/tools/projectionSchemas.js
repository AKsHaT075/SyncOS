const { z } = require('zod');
const { LIMITS } = require('./projections');
const { PROJECT_MEMBER_ROLES, PROJECT_PRIORITY, PROJECT_STATUS, PROJECT_TYPE } = require('../../../constants/project.constants');
const { TASK_PRIORITY, TASK_STATUS } = require('../../../constants/task.constants');
const { MEETING_STATUS, MEETING_TYPE } = require('../../../constants/meeting.constants');
const { ROLES } = require('../../../constants/roles');

/**
 * The strict allowlists (zod `.strict()`) for every AI projection: this is what a future tool passes as its `resultSchema`.
 * A field not listed here is a FAILURE in the tool-result gate, not something that is dropped. The tool-result validator (toolResult.js)
 * still applies its own limits (depth, string length, records, bytes, plain data) on top of these.
 */

const id = z.string().regex(/^[a-f0-9]{24}$/);
const name = z.string().max(LIMITS.name);
const title = z.string().max(LIMITS.title);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const internalHref = z.string().max(160).regex(/^\/dashboard\/[A-Za-z0-9/_-]*$/); // an in-app path only: never a scheme, host or query
const count = z.number().int().min(0).max(1_000_000);
const strict = (shape) => z.object(shape).strict();

const listText = z.string().max(190); // whole names joined with "; " (see projections.nameList)

// DEPTH: rows are FLAT (primitives only) so { data: [row], summary } stays inside the tool-result depth limit without relaxing it.
const task = strict({
  id, title,
  status: z.enum(Object.values(TASK_STATUS)),
  priority: z.enum(Object.values(TASK_PRIORITY)),
  due: dateOnly.nullable(),
  overdue: z.boolean(),
  projectId: id.nullable(),
  projectName: title.nullable(),
  assignees: listText,
  assigneeCount: count,
  href: internalHref.nullable(),
});

const project = strict({
  id, name: title,
  status: z.enum(Object.values(PROJECT_STATUS)),
  priority: z.enum(Object.values(PROJECT_PRIORITY)),
  type: z.enum(Object.values(PROJECT_TYPE)),
  start: dateOnly.nullable(),
  due: dateOnly.nullable(),
  pastDue: z.boolean(),
  owner: name.nullable(),
  memberCount: count,
  href: internalHref.nullable(),
  openTasks: count.optional(),
  overdueTasks: count.optional(),
});

const projectMember = strict({ id, name, projectRole: z.enum(Object.values(PROJECT_MEMBER_ROLES)) });

// A single-team DETAIL may carry `members` (names, depth-safe inside { team }); a LIST of teams must omit it.
const team = strict({
  id, name: title,
  lead: name.nullable(),
  memberCount: count,
  members: z.array(name).max(LIMITS.members).optional(),
});

const person = strict({ id, name, role: z.enum(Object.values(ROLES)), team: name.nullable() });

const meeting = strict({
  id, topic: title,
  status: z.enum(Object.values(MEETING_STATUS)),
  type: z.enum(Object.values(MEETING_TYPE)),
  start: instant.nullable(),
  end: instant.nullable(),
  host: name.nullable(),
  participantCount: count,
  projectId: id.nullable(),
  projectName: title.nullable(),
  href: internalHref.nullable(),
});

const calendarEntry = strict({
  id: z.string().regex(/^(meeting|task|project|event):[a-f0-9]{24}(:\d{1,16})?$/),
  category: z.string().max(20),
  title,
  allDay: z.boolean(),
  start: instant.nullable(),
  end: instant.nullable(),
  startDate: dateOnly.nullable(),
  endDate: dateOnly.nullable(),
  status: z.string().max(20).nullable(),
  projectId: id.nullable(),
  projectName: title.nullable(),
  href: internalHref.nullable(),
});

module.exports = { AI_SCHEMAS: Object.freeze({ calendarEntry, meeting, person, project, projectMember, task, team }) };
