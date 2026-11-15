const AppError = require('../../utils/app-error');

/**
 * NODE'S registry of AI tools: the single source of truth for what a tool is, who may use it, and what
 * its arguments look like. Python never defines or authorizes tools; it can only ask Node to run one.
 *
 * Deliberately EMPTY in production for now (read tools register here once enabled).
 * Only the authorization gate that will front every tool exists today (aiCallbacks.service.js).
 *
 * definition: { name, kind: 'read', permission, schema (zod object: the ARGUMENTS, strict),
 *                resultSchema (zod: the explicit allowlist of what a result may contain, REQUIRED),
 *                run({ actor, input, signal, maxTimeMs }),
 *                auditFields?: argument names safe to record in the audit log (enums/booleans/numbers),
 *                label?: fixed, human-readable progress text (never derived from data),
 *                description?: fixed text the model is shown for this tool (written here, never derived from data) }
 *
 * `run` MUST honour `signal` (aborted on timeout / cancel / request end) and pass `maxTimeMs` to every database query as maxTimeMS.
 */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const KINDS = Object.freeze({ READ: 'read' });
const tools = new Map();

function registerTool(definition) {
  const { name, kind, permission, schema, resultSchema, run, auditFields, label, description } = definition || {};
  if (
    !TOOL_NAME.test(name || '') || !Object.values(KINDS).includes(kind) || !permission
    || typeof schema?.safeParse !== 'function' || typeof resultSchema?.safeParse !== 'function' || typeof run !== 'function'
    || (auditFields !== undefined && !(Array.isArray(auditFields) && auditFields.every((f) => typeof f === 'string')))
    || (label !== undefined && (typeof label !== 'string' || label.length > 80))
    || (description !== undefined && (typeof description !== 'string' || description.length > 700))
  ) {
    throw new AppError('Invalid AI tool definition', 500, 'AI_TOOL_DEFINITION');
  }
  if (tools.has(name)) throw new AppError('Duplicate AI tool', 500, 'AI_TOOL_DEFINITION');
  tools.set(name, Object.freeze({ ...definition }));
}

const findTool = (name) => (typeof name === 'string' ? tools.get(name) || null : null);
const clearTools = () => tools.clear(); // tests only

/**
 * What the model is told about the tools this user may use: name, Node-written description, and the argument JSON Schema generated
 * from the SAME strict schema that validates the call. Only tools the user's role may run are listed (a convenience for the model;
 * the callback gate re-checks everything and never trusts this list).
 */
function listToolDefinitions({ permissions = [] } = {}) {
  const { z } = require('zod'); // eslint-disable-line global-require
  return [...tools.values()]
    .filter((tool) => permissions.includes(tool.permission))
    .map((tool) => ({ name: tool.name, description: tool.description || '', label: tool.label || null, parameters: z.toJSONSchema(tool.schema, { target: 'draft-7' }) }));
}

module.exports = { KINDS, clearTools, findTool, listToolDefinitions, registerTool };
