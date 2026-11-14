const { z } = require('zod');
const { PERMISSIONS } = require('../../../constants/permissions');
const { dueWindow } = require('../../../utils/aiDateRanges');
const { resolveTimeZone } = require('../../calendar.service');
const { projectProject } = require('./projections');
const { AI_SCHEMAS } = require('./projectionSchemas');
const { outcomeShape, refArgument, resolveProject } = require('./projectLookup');
const { statusBreakdown } = require('./taskCounts');
const { ensureActive, guarded, peopleNames } = require('./toolSupport');

/**
 * get_project_overview: one project the user can see, with status, priority, type, owner, dates and the counts of tasks THEY can see.
 * Never returns the description, client, budget, notes or links. The reference is an id or a name, resolved only inside the AI
 * visibility scope; several equally good matches return safe candidates (also only from that scope) instead of a guess; a missing,
 * inaccessible or other-organization reference is one and the same `not_found`.
 */

const argumentsSchema = z.object({ project: refArgument }).strict();

const counts = z.object({ todo: z.number().int().min(0), inProgress: z.number().int().min(0), inReview: z.number().int().min(0), completed: z.number().int().min(0), cancelled: z.number().int().min(0), overdue: z.number().int().min(0) }).strict();
const resultSchema = z.object({
  ...outcomeShape,
  project: AI_SCHEMAS.project.nullable(),
  taskStatusCounts: counts.nullable(),
  asOf: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timeZone: z.string().max(64) }).strict(),
}).strict();

function createGetProjectOverviewTool({ now = () => Date.now() } = {}) {
  return {
    name: 'get_project_overview',
    kind: 'read',
    permission: PERMISSIONS.USE_AI,
    label: 'Checking project details...',
    description: 'Shows one project the signed-in user can see, by id or name: status, priority, type, owner, start and due dates, member count, whether it is past due, and counts of tasks by status (only tasks the user is allowed to see). If the name matches several projects it returns the candidates instead of choosing. Read-only; never shows descriptions, clients, budgets or links.',
    schema: argumentsSchema,
    resultSchema,
    auditFields: [],
    async run({ actor, input, signal, maxTimeMs }) {
      ensureActive(signal);
      const nowMs = now();
      const { timeZone } = await guarded(signal, () => resolveTimeZone(actor));
      const { today } = dueWindow({ due: 'today', nowMs, timeZone });
      const todayUtc = new Date(`${today}T00:00:00.000Z`);
      const asOf = { date: today, timeZone };

      const resolved = await resolveProject(actor, input.project, { signal, maxTimeMs });
      ensureActive(signal);
      if (resolved.outcome !== 'found') {
        return { outcome: resolved.outcome, matchedBy: null, candidates: resolved.candidates, project: null, taskStatusCounts: null, asOf };
      }
      const { project, scope } = resolved;
      const breakdown = await statusBreakdown(actor, scope, project._id, todayUtc, { signal, maxTimeMs });
      const names = await peopleNames(actor, [project.owner], { signal, maxTimeMs });
      const open = breakdown.todo + breakdown.inProgress + breakdown.inReview;
      return {
        outcome: 'found',
        matchedBy: resolved.matchedBy,
        candidates: [],
        project: projectProject(project, { names, today, counts: { open, overdue: breakdown.overdue } }),
        taskStatusCounts: breakdown,
        asOf,
      };
    },
  };
}

module.exports = { argumentsSchema, createGetProjectOverviewTool, resultSchema };
