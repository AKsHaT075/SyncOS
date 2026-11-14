const { z } = require('zod');
const { PROJECT_STATUS } = require('../../../constants/project.constants');
const Project = require('../../../models/Project');
const { buildAiProjectFilter, classifyProjects } = require('../../../utils/aiAccess');
const aiScope = require('./aiScope');
const { resolveRef } = require('./nameResolution');
const { cleanText, dateOnly, idString, personName } = require('./projections');
const { peopleNames } = require('./toolSupport');

/**
 * Shared by the single-project tools (get_project_overview, list_project_members, list_project_tasks).
 *
 * The caller's reference (id or name) is resolved ONLY inside the AI project visibility filter. Everything the tool then does about
 * that project uses a scope made of JUST that project (classifyProjects), so the 2,000-visible-project cap can never silently
 * make a count or a task list wrong for a project that was resolved successfully.
 */

const SELECT = 'name status priority type dueDate startDate owner members visibility team organization archived deletedAt';

const candidateSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  name: z.string().max(160),
  status: z.enum(Object.values(PROJECT_STATUS)),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  owner: z.string().max(120).nullable(),
}).strict();

const outcomeShape = {
  outcome: z.enum(['found', 'ambiguous', 'not_found']),
  matchedBy: z.enum(['id', 'exact_name', 'partial_name']).nullable(),
  candidates: z.array(candidateSchema).max(5),
};

const projectRefSchema = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/), name: z.string().max(160) }).strict();
const refArgument = z.string().trim().min(1).max(120);

/** Safe candidate rows: only projects the user can see, with enough to tell identical names apart (status, due date, owner). */
async function candidateRows(actor, projects, { signal, maxTimeMs }) {
  const names = await peopleNames(actor, projects.map((p) => p.owner), { signal, maxTimeMs });
  return projects.map((p) => ({
    id: idString(p._id),
    name: cleanText(p.name, 160),
    status: p.status,
    due: dateOnly(p.dueDate),
    owner: idString(p.owner) ? personName(p.owner, names) : null,
  }));
}

/** @returns {{ outcome, matchedBy, project: object|null, candidates: object[], scope: object|null }} */
async function resolveProject(actor, ref, { signal, maxTimeMs } = {}) {
  const found = await resolveRef({
    model: Project,
    baseFilter: buildAiProjectFilter(actor),
    ref,
    select: SELECT,
    findById: (id) => aiScope.findAiProject(actor, id, { maxTimeMs }),
    signal,
    maxTimeMs,
  });
  if (found.outcome === 'found') {
    return { outcome: 'found', matchedBy: found.matchedBy, project: found.record, candidates: [], scope: classifyProjects(actor, [found.record]) };
  }
  const candidates = found.outcome === 'ambiguous' ? await candidateRows(actor, found.candidates, { signal, maxTimeMs }) : [];
  return { outcome: found.outcome, matchedBy: null, project: null, candidates, scope: null };
}

module.exports = { candidateSchema, outcomeShape, projectRefSchema, refArgument, resolveProject };
