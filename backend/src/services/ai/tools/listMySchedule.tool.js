const { z } = require('zod');
const { PERMISSIONS } = require('../../../constants/permissions');
const { OPEN_TASK_STATUSES, RUNNING_PROJECT_STATUSES } = require('../../../constants/analytics.constants');
const { MEETING_STATUS } = require('../../../constants/meeting.constants');
const { DEFAULT_MEETING_DURATION_MS } = require('../../../constants/calendar.constants');
const Meeting = require('../../../models/Meeting');
const Project = require('../../../models/Project');
const Task = require('../../../models/Task');
const { buildAiMeetingFilter, buildAiTaskFilter } = require('../../../utils/aiAccess');
const { DAY_MS, RANGES, compareSchedule, computeRange } = require('../../../utils/aiDateRanges');
const { dateOnlyString } = require('../../../utils/timezone');
const { resolveTimeZone } = require('../../calendar.service');
const aiScope = require('./aiScope');
const { fitRows, instant, projectCalendarEntry } = require('./projections');
const { AI_SCHEMAS } = require('./projectionSchemas');
const { ensureActive, guarded, projectNames, timed } = require('./toolSupport');

/**
 * list_my_schedule: the signed-in user's OWN schedule for a named range.
 *
 * Why this does not call calendarQuery.getCalendar: its collectors let an administrator see every meeting and task in the
 * organization and do not apply the AI visibility rules. This tool therefore runs three narrow, bounded queries of its own, each
 * through the AI filters from utils/aiAccess (private projects / tasks never open to administrators):
 *   meetings  where the user is the HOST or a PARTICIPANT, in a project visible under the AI rules, not cancelled
 *   tasks     assigned to the user, open, due in the range, visible under the AI task rule
 *   projects  whose deadline falls in the range, where the user is the OWNER or a listed MEMBER (not merely able to see it)
 * Standalone calendar events are NOT included in this version (their access rules are a separate model).
 * Nothing free-text beyond titles is returned: no descriptions, locations, participant lists, join links or room names.
 */

const TYPES = ['meeting', 'task', 'project'];
const MAX_ENTRIES = 30;
const SOURCE_CAP = MAX_ENTRIES + 1; // per source: one more than we could show, so "there is more" is known

const argumentsSchema = z.object({
  range: z.enum(RANGES).optional(),
  types: z.array(z.enum(TYPES)).min(1).max(TYPES.length).optional(),
}).strict();

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const resultSchema = z.object({
  data: z.array(AI_SCHEMAS.calendarEntry).max(MAX_ENTRIES),
  summary: z.object({ count: z.number().int().min(0), total: z.number().int().min(0), truncated: z.boolean(), complete: z.boolean() }).strict(),
  asOf: z.object({ date: dateString, timeZone: z.string().max(64) }).strict(),
  range: z.object({ name: z.enum(RANGES), from: dateString, to: dateString }).strict(),
}).strict();

function createListMyScheduleTool({ now = () => Date.now() } = {}) {
  return {
    name: 'list_my_schedule',
    kind: 'read',
    permission: PERMISSIONS.USE_AI,
    label: 'Checking your schedule...',
    description: 'Lists the signed-in user\'s own schedule for a range (today, next_7_days, this_week = Monday to Sunday, or next_14_days): meetings they host or attend, their open tasks that fall due, and deadlines of projects they belong to, in chronological order. Read-only; shows only items the user is allowed to see. Does not include meeting descriptions, locations, attendee lists or join links.',
    schema: argumentsSchema,
    resultSchema,
    auditFields: ['range'],
    async run({ actor, input, signal, maxTimeMs }) {
      ensureActive(signal);
      const nowMs = now();
      const { timeZone } = await guarded(signal, () => resolveTimeZone(actor));
      const name = input.range || 'next_7_days';
      const range = computeRange({ range: name, nowMs, timeZone });
      const wanted = new Set(input.types || TYPES);

      const scope = await aiScope.resolveAiScope(actor, { maxTimeMs });
      ensureActive(signal);

      let capped = false;
      const entries = [];
      const capCheck = (rows) => { if (rows.length >= SOURCE_CAP) capped = true; };

      if (wanted.has('meeting')) {
        const rows = await guarded(signal, () => timed(Meeting.find({
          $and: [
            buildAiMeetingFilter(actor, scope),
            { $or: [{ host: actor._id }, { 'participants.user': actor._id }] }, // personal only: never "every meeting of a project I can see"
            { status: { $ne: MEETING_STATUS.CANCELLED } },
            // A meeting may start up to a day before the range and still overlap it; exact overlap is checked below.
            { startTime: { $lt: new Date(range.endMs), $gte: new Date(range.startMs - DAY_MS) } },
          ],
        }).sort({ startTime: 1 }).limit(SOURCE_CAP).select('topic status startTime endTime project').lean(), maxTimeMs));
        capCheck(rows);
        const projects = await projectNames(actor, rows.map((m) => m.project), { signal, maxTimeMs });
        for (const meeting of rows) {
          const start = meeting.startTime.getTime();
          const end = meeting.endTime ? meeting.endTime.getTime() : start + DEFAULT_MEETING_DURATION_MS;
          if (!(end > range.startMs && start < range.endMs)) continue; // eslint-disable-line no-continue
          entries.push({
            id: `meeting:${meeting._id}`, category: 'meeting', title: meeting.topic, allDay: false,
            start: instant(meeting.startTime), end: meeting.endTime ? instant(meeting.endTime) : null, status: meeting.status,
            project: { id: String(meeting.project), name: projects.get(String(meeting.project)) || 'Project' },
          });
        }
      }

      if (wanted.has('task')) {
        const rows = await guarded(signal, () => timed(Task.find({
          $and: [
            buildAiTaskFilter(actor, scope),
            { assignees: actor._id },
            { status: { $in: OPEN_TASK_STATUSES } },
            { dueDate: { $gte: range.fromDateUtc, $lte: range.toDateUtc } }, // date-only values: UTC-midnight bounds, never shifted
          ],
        }).sort({ dueDate: 1, _id: 1 }).limit(SOURCE_CAP).select('title status dueDate project').lean(), maxTimeMs));
        capCheck(rows);
        const projects = await projectNames(actor, rows.map((t) => t.project), { signal, maxTimeMs });
        for (const task of rows) {
          const due = dateOnlyString(task.dueDate.getTime());
          entries.push({
            id: `task:${task._id}`, category: 'task', title: task.title, allDay: true, startDate: due, endDate: due, status: task.status,
            project: { id: String(task.project), name: projects.get(String(task.project)) || 'Project' },
          });
        }
      }

      if (wanted.has('project')) {
        const rows = await guarded(signal, () => timed(Project.find({
          $and: [
            { _id: { $in: scope.memberProjectIds } }, // owner or listed member of a project visible under the AI rules
            { status: { $in: RUNNING_PROJECT_STATUSES } },
            { dueDate: { $gte: range.fromDateUtc, $lte: range.toDateUtc } },
          ],
        }).sort({ dueDate: 1, _id: 1 }).limit(SOURCE_CAP).select('name status dueDate').lean(), maxTimeMs));
        capCheck(rows);
        for (const project of rows) {
          const due = dateOnlyString(project.dueDate.getTime());
          entries.push({ id: `project:${project._id}`, category: 'project', title: project.name, allDay: true, startDate: due, endDate: due, status: project.status, project: { id: String(project._id), name: project.name } });
        }
      }

      ensureActive(signal);
      const projected = entries.map(projectCalendarEntry).filter(Boolean).sort((a, b) => compareSchedule(a, b, timeZone));
      const shown = projected.slice(0, MAX_ENTRIES);
      const fit = fitRows(shown, { reserveBytes: 700 });
      return {
        data: fit.rows,
        summary: { count: fit.rows.length, total: projected.length, truncated: projected.length > fit.rows.length || capped, complete: !scope.truncated && !capped },
        asOf: { date: range.today, timeZone },
        range: { name, from: range.fromDate, to: range.toDate },
      };
    },
  };
}

module.exports = { MAX_ENTRIES, argumentsSchema, createListMyScheduleTool, resultSchema };
