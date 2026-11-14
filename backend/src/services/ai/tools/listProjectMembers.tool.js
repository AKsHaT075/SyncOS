const { z } = require('zod');
const { PERMISSIONS } = require('../../../constants/permissions');
const { PROJECT_MEMBER_ROLES } = require('../../../constants/project.constants');
const User = require('../../../models/User');
const { buildAiPeopleFilter } = require('../../../utils/aiAccess');
const { LIMITS, cleanText, idString, personName, projectProjectMember } = require('./projections');
const { AI_SCHEMAS } = require('./projectionSchemas');
const { outcomeShape, projectRefSchema, refArgument, resolveProject } = require('./projectLookup');
const { ensureActive, guarded, timed } = require('./toolSupport');

/**
 * list_project_members: the roster of one project the user can see: member id, display name and PROJECT role (Owner / Manager /
 * Contributor / Viewer, from the project's own data, never inferred from an organization role). The owner appears once; a person
 * listed twice appears once; deactivated and blocked people never appear. Nothing about anyone outside the roster is read.
 * Contact details are never selected from the database in the first place.
 */

const argumentsSchema = z.object({ project: refArgument }).strict();
const MAX_ROSTER = LIMITS.members; // 50 shown
const LOOKUP_CAP = 300; // roster entries examined; beyond this the answer says it is incomplete

const resultSchema = z.object({
  ...outcomeShape,
  project: projectRefSchema.nullable(),
  data: z.array(AI_SCHEMAS.projectMember).max(MAX_ROSTER),
  summary: z.object({ count: z.number().int().min(0), total: z.number().int().min(0), truncated: z.boolean(), complete: z.boolean() }).strict(),
}).strict();

const ROLE_ORDER = { [PROJECT_MEMBER_ROLES.OWNER]: 0, [PROJECT_MEMBER_ROLES.MANAGER]: 1, [PROJECT_MEMBER_ROLES.CONTRIBUTOR]: 2, [PROJECT_MEMBER_ROLES.VIEWER]: 3 };

function createListProjectMembersTool() {
  return {
    name: 'list_project_members',
    kind: 'read',
    permission: PERMISSIONS.USE_AI,
    label: 'Checking project members...',
    description: 'Lists who is on one project the signed-in user can see, by id or name: each person\'s name and their role on THAT project (Owner, Manager, Contributor, Viewer). Inactive or blocked people are left out. If the name matches several projects it returns the candidates instead of choosing. Read-only; shows no contact details.',
    schema: argumentsSchema,
    resultSchema,
    auditFields: [],
    async run({ actor, input, signal, maxTimeMs }) {
      ensureActive(signal);
      const none = (resolved) => ({ outcome: resolved.outcome, matchedBy: null, candidates: resolved.candidates, project: null, data: [], summary: { count: 0, total: 0, truncated: false, complete: true } });
      const resolved = await resolveProject(actor, input.project, { signal, maxTimeMs });
      ensureActive(signal);
      if (resolved.outcome !== 'found') return none(resolved);
      const { project } = resolved;

      // The roster as the project's data defines it: the owner field, then listed members; each person once.
      const seen = new Set();
      const entries = [];
      const ownerId = idString(project.owner);
      if (ownerId) { seen.add(ownerId); entries.push({ user: project.owner, role: PROJECT_MEMBER_ROLES.OWNER }); }
      for (const member of project.members || []) {
        const id = idString(member.user);
        if (!id || seen.has(id)) continue; // eslint-disable-line no-continue
        seen.add(id);
        entries.push({ user: member.user, role: member.role });
      }
      const examined = entries.slice(0, LOOKUP_CAP);

      const people = await guarded(signal, () => timed(
        User.find({ _id: { $in: examined.map((e) => idString(e.user)) }, ...buildAiPeopleFilter(actor) }).select('firstName lastName').lean(),
        maxTimeMs,
      ));
      const names = new Map(people.map((p) => [idString(p._id), personName(p, null)]));
      const active = examined
        .filter((e) => names.has(idString(e.user))) // an inactive / blocked / foreign person is simply not on the list
        .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || names.get(idString(a.user)).localeCompare(names.get(idString(b.user))) || (idString(a.user) < idString(b.user) ? -1 : 1));
      const rows = active.slice(0, MAX_ROSTER).map((e) => projectProjectMember(e, { names }));
      return {
        outcome: 'found',
        matchedBy: resolved.matchedBy,
        candidates: [],
        project: { id: idString(project._id), name: cleanText(project.name, 160) },
        data: rows,
        summary: { count: rows.length, total: active.length, truncated: active.length > rows.length, complete: entries.length <= LOOKUP_CAP },
      };
    },
  };
}

module.exports = { argumentsSchema, createListProjectMembersTool, resultSchema, MAX_ROSTER };
