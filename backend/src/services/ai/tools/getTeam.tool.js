const { z } = require('zod');
const { PERMISSIONS } = require('../../../constants/permissions');
const Team = require('../../../models/Team');
const User = require('../../../models/User');
const { buildAiPeopleFilter, buildAiTeamFilter } = require('../../../utils/aiAccess');
const aiScope = require('./aiScope');
const { resolveRef } = require('./nameResolution');
const { LIMITS, cleanText, idString, personName, projectTeam } = require('./projections');
const { AI_SCHEMAS } = require('./projectionSchemas');
const { HEX24, ensureActive, guarded, normalizeRef, timed } = require('./toolSupport');

/**
 * get_team: teams the user can see, or one team in detail.
 *
 * Visibility is the approved policy: admin / org-admin / HR see every team of their organization (as in the product), EVERYONE ELSE
 * only teams they lead or belong to. A manager who is not on a team gets none: a manager is not an org-wide team administrator.
 * Names are resolved only inside that scope. Without `team`: a LIST of visible teams (rows WITHOUT members). With `team` (id or
 * name): the team in detail, with the names of its ACTIVE members (at most 50). Deactivated and blocked people are never named or
 * counted. Contact details are never selected.
 */

const argumentsSchema = z.object({ team: z.string().trim().min(1).max(120).optional() }).strict();
const LIST_LIMIT = 20;
const LOOKUP_CAP = 300;
const SELECT = 'name lead members organization';

const candidate = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/), name: z.string().max(160) }).strict();
const teamRow = AI_SCHEMAS.team.omit({ members: true }).strict();
const resultSchema = z.object({
  outcome: z.enum(['list', 'found', 'ambiguous', 'not_found']),
  matchedBy: z.enum(['id', 'exact_name', 'partial_name']).nullable(),
  teams: z.array(teamRow).max(LIST_LIMIT),
  team: AI_SCHEMAS.team.nullable(),
  candidates: z.array(candidate).max(5),
  summary: z.object({ count: z.number().int().min(0), total: z.number().int().min(0), truncated: z.boolean(), complete: z.boolean() }).strict(),
}).strict();

const empty = (outcome, extra = {}) => ({ outcome, matchedBy: null, teams: [], team: null, candidates: [], summary: { count: 0, total: 0, truncated: false, complete: true }, ...extra });

/** id -> display name for the ACTIVE, non-blocked, same-organization people among `ids`. */
async function activeNames(actor, ids, { signal, maxTimeMs }) {
  const unique = [...new Set(ids.map(idString).filter(Boolean))].slice(0, LOOKUP_CAP);
  if (unique.length === 0) return new Map();
  const rows = await guarded(signal, () => timed(User.find({ _id: { $in: unique }, ...buildAiPeopleFilter(actor) }).select('firstName lastName').lean(), maxTimeMs));
  return new Map(rows.map((row) => [idString(row._id), personName(row, null)]));
}

/** A team as AI shows it: only active members are counted and named; the lead is named only if they are active. */
function shape(team, names, { includeMembers }) {
  const active = [...new Set((team.members || []).map(idString).filter((id) => id && names.has(id)))];
  const row = projectTeam({ _id: team._id, name: team.name, lead: idString(team.lead) && names.has(idString(team.lead)) ? team.lead : null, members: active }, { names, includeMembers });
  return row;
}

function createGetTeamTool() {
  return {
    name: 'get_team',
    kind: 'read',
    permission: PERMISSIONS.USE_AI,
    label: 'Looking up teams...',
    description: 'Without arguments, lists the teams the signed-in user can see (name, lead, active member count). With a team id or name, shows that team: its lead and the names of its active members. Administrators and HR can see every team; other people only teams they lead or belong to. If the name matches several teams it returns the candidates instead of choosing. Read-only; shows no contact details.',
    schema: argumentsSchema,
    resultSchema,
    auditFields: [],
    async run({ actor, input, signal, maxTimeMs }) {
      ensureActive(signal);
      const baseFilter = buildAiTeamFilter(actor);

      if (!input.team) {
        const total = await guarded(signal, () => timed(Team.countDocuments(baseFilter), maxTimeMs));
        const teams = await guarded(signal, () => timed(Team.find(baseFilter).sort({ name: 1, _id: 1 }).limit(LIST_LIMIT).select(SELECT).lean(), maxTimeMs));
        const names = await activeNames(actor, teams.flatMap((t) => [t.lead, ...(t.members || [])]), { signal, maxTimeMs });
        const rows = teams.map((t) => shape(t, names, { includeMembers: false })); // a LIST never carries member names
        const incomplete = teams.some((t) => (t.members || []).length > LOOKUP_CAP);
        return empty('list', { teams: rows, summary: { count: rows.length, total, truncated: total > rows.length, complete: !incomplete } });
      }

      const text = normalizeRef(input.team);
      const resolved = await resolveRef({
        model: Team,
        baseFilter,
        ref: text,
        select: SELECT,
        findById: (id) => aiScope.findAiTeam(actor, id, { maxTimeMs }),
        signal,
        maxTimeMs,
      });
      ensureActive(signal);
      if (resolved.outcome === 'not_found') return empty('not_found');
      if (resolved.outcome === 'ambiguous') return empty('ambiguous', { candidates: resolved.candidates.map((t) => ({ id: idString(t._id), name: cleanText(t.name, 160) })) });

      const team = resolved.record;
      const names = await activeNames(actor, [team.lead, ...(team.members || [])], { signal, maxTimeMs });
      const detail = shape(team, names, { includeMembers: true });
      const activeCount = [...new Set((team.members || []).map(idString).filter((id) => id && names.has(id)))].length;
      return empty('found', { matchedBy: resolved.matchedBy, team: detail, summary: { count: 1, total: 1, truncated: activeCount > LIMITS.members, complete: (team.members || []).length <= LOOKUP_CAP } });
    },
  };
}

module.exports = { argumentsSchema, createGetTeamTool, resultSchema, HEX24 };
