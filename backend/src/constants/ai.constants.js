/**
 * AI constants. Provider-neutral on purpose: only the Python AI service (`ai/`)
 * knows about a specific vendor.
 */

// What a model is being used for. Each purpose can be routed to its own model via env.
const AI_PURPOSES = Object.freeze({
  CHAT: 'chat',
  SUMMARIZE: 'summarize',
});

// Normalized provider failures. These (and only these) cross the provider boundary.
const AI_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED', // no key / unknown provider
  DISABLED: 'AI_DISABLED', // org (or platform) has not enabled AI
  RATE_LIMITED: 'AI_PROVIDER_RATE_LIMITED',
  TIMEOUT: 'AI_PROVIDER_TIMEOUT',
  UNAVAILABLE: 'AI_PROVIDER_UNAVAILABLE',
  AUTH: 'AI_PROVIDER_AUTH', // our key was rejected: an operator problem, never the user's
  CONTEXT_TOO_LONG: 'AI_CONTEXT_TOO_LONG',
  CONTENT_FILTERED: 'AI_CONTENT_FILTERED',
  TOOL_ERROR: 'AI_PROVIDER_TOOL_ERROR', // model produced an invalid tool call
  BAD_REQUEST: 'AI_PROVIDER_BAD_REQUEST', // our request was malformed (a bug on our side)
  ABORTED: 'AI_REQUEST_ABORTED', // caller cancelled; not an error to report to the user
  INVALID_RESPONSE: 'AI_PROVIDER_INVALID_RESPONSE',
  // Failures of the Node -> Python hop itself (never produced by the provider).
  SERVICE_UNAVAILABLE: 'AI_SERVICE_UNAVAILABLE', // unreachable / refused / 5xx / stream cut off
  SERVICE_TIMEOUT: 'AI_SERVICE_TIMEOUT',
  SERVICE_AUTH: 'AI_SERVICE_AUTH', // Python rejected our token (key mismatch / clock skew): an operator problem
  SERVICE_PROTOCOL: 'AI_SERVICE_PROTOCOL', // reply that violates the contract
  // Retrieval (Phase 5)
  RETRIEVAL_UNAVAILABLE: 'AI_RETRIEVAL_UNAVAILABLE', // embedding / vector search / authorization failed: no answer is given
  KNOWLEDGE_NOT_READY: 'AI_KNOWLEDGE_NOT_READY', // no embedding space is active yet: nothing has been indexed for retrieval
  // Live organizational data / tools (Phase 8)
  LIVE_DATA_DISABLED: 'AI_LIVE_DATA_DISABLED', // the organization has not switched live data on (or switched it off)
  LIVE_DATA_REQUIRES_AI: 'AI_LIVE_DATA_REQUIRES_AI',
  PLATFORM_LIVE_TOOLS_DISABLED: 'AI_LIVE_TOOLS_PLATFORM_DISABLED', // the PLATFORM emergency switch for live tools (distinct from an organization's own setting)
});

// What a tool callback can be refused for. Messages are fixed; arguments / data are never echoed.
// The eight live-data tools, by name. The ONLY tool names a `tool_activity` event may carry on the Python hop or to a browser. A test pins
// this list to the tool registry, so adding a tool without updating it (deliberately) fails.
const AI_LIVE_TOOL_NAMES = Object.freeze([
  'list_my_tasks', 'list_my_schedule', 'list_projects', 'get_project_overview', 'list_project_members', 'list_project_tasks', 'get_team', 'get_workload_summary',
]);

const AI_TOOL_ERRORS = Object.freeze({
  NOT_FOUND: 'AI_TOOL_NOT_FOUND', // unknown, forbidden, not executable, or no tool budget for this request: indistinguishable
  BAD_ARGUMENTS: 'AI_TOOL_BAD_ARGUMENTS',
  BUDGET: 'AI_TOOL_BUDGET', // call count / total tool time spent
  CONCURRENCY: 'AI_TOOL_CONCURRENCY',
  DUPLICATE: 'AI_TOOL_DUPLICATE',
  TIMEOUT: 'AI_TOOL_TIMEOUT',
  ABORTED: 'AI_TOOL_ABORTED',
  RESULT_TOO_LARGE: 'AI_TOOL_RESULT_TOO_LARGE',
  RESULT_INVALID: 'AI_TOOL_RESULT_INVALID', // did not match the tool's allowlist schema, or was not plain data
  FAILED: 'AI_TOOL_FAILED',
});

// Which product feature made the call (usage reporting only; never affects permissions).
const AI_FEATURES = Object.freeze({
  CHAT: 'chat',
  SUMMARIZE: 'summarize',
  DOCUMENT_QA: 'document_qa',
  TOOLS: 'tools',
  REPORT: 'report',
  OTHER: 'other',
});

const AI_USAGE_STATUS = Object.freeze({
  SUCCESS: 'success',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  DENIED: 'denied', // refused by a quota before any provider call
});

// Limits, quotas and fail-closed errors raised by the request pipeline.
const AI_LIMIT_CODES = Object.freeze({
  RATE_LIMITED: 'AI_RATE_LIMITED',
  TOO_MANY_CONCURRENT: 'AI_TOO_MANY_CONCURRENT',
  QUOTA_USER_DAILY: 'AI_QUOTA_USER_DAILY',
  QUOTA_ORG_MONTHLY: 'AI_QUOTA_ORG_MONTHLY',
  REQUEST_TOO_LARGE: 'AI_QUOTA_REQUEST_TOO_LARGE',
  LIMITS_UNAVAILABLE: 'AI_LIMITS_UNAVAILABLE', // Redis down: AI is refused rather than run unmetered
});

// The disclosure an org admin must accept before AI can be turned on.
// Bump `version` whenever the text changes in a way that needs re-acceptance.
const AI_DISCLOSURE = Object.freeze({
  version: 'v1-2026-11',
  title: 'Enable AI features for your organization',
  provider: 'Groq',
  points: [
    'When AI is enabled, members can send questions to an external AI provider (Groq) to get answers.',
    'To answer, Sync OS may include content the asking member is permitted to see: the text of their question, excerpts of documents, and task, project, meeting or calendar details. Content a member cannot open in Sync OS is not sent on their behalf.',
    'This content leaves Sync OS and is processed by the provider under the provider\'s own terms. Review those terms and your organization\'s data policies before enabling.',
    'Private documents are included only for their owner. Organization admins do not gain access to other members\' private documents through AI.',
    'Guests cannot use AI.',
    'Usage (token counts, model, timing and cost estimate) is recorded per member. The text of questions and answers is stored only in the member\'s own conversation history.',
    'You can turn AI off at any time. Turning it off stops all AI requests immediately.',
  ],
});

// The SECOND disclosure: needed only to turn on live organizational data (Phase 8), separate from the base AI disclosure so
// organizations that already accepted the base one are not forced to re-accept it.
const AI_LIVE_DATA_DISCLOSURE = Object.freeze({
  version: 'v1-2026-11-live',
  title: 'Let AI use live organizational data',
  provider: 'Groq',
  points: [
    'When live data is enabled, the assistant can look up the asking member\'s tasks, schedule, and the projects and teams they can already see, and send the results to the external AI provider (Groq) to answer their question.',
    'Results can include names of people (for example project members or a team lead), task and project titles, dates and statuses. Descriptions, comments, attachments, email addresses and meeting links are not sent.',
    'Private projects and private tasks are included only for people directly involved in them. Organization admins do not gain access to other members\' private projects or tasks through AI.',
    'Every lookup is checked again when it runs, against the member\'s current access. The assistant can only read; it cannot change anything.',
    'Each lookup is recorded in the audit log (which lookup, when, and how many records) without the question or the data itself.',
    'You can turn live data off at any time. It stops all lookups immediately, including in conversations that are already running. Turning AI off also turns live data off.',
  ],
});

// Defaults; tokens are input + output combined.
const AI_QUOTA_DEFAULTS = Object.freeze({
  userDailyTokens: 100000,
  orgMonthlyTokens: 5000000,
});
const AI_QUOTA_BOUNDS = Object.freeze({ min: 1000, max: 1000000000 });

module.exports = {
  AI_DISCLOSURE,
  AI_LIVE_DATA_DISCLOSURE,
  AI_ERROR_CODES,
  AI_TOOL_ERRORS,
  AI_LIVE_TOOL_NAMES,
  AI_FEATURES,
  AI_LIMIT_CODES,
  AI_USAGE_STATUS,
  AI_PURPOSES,
  AI_QUOTA_BOUNDS,
  AI_QUOTA_DEFAULTS,
};
