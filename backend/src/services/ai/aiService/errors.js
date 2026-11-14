const AppError = require('../../../utils/app-error');
const { AI_ERROR_CODES: C } = require('../../../constants/ai.constants');

/**
 * The only error shape that leaves a provider adapter. It carries NO upstream
 * message text (upstream errors can echo prompt content) and never the API key.
 */
class AiProviderError extends AppError {
  constructor(code, message, { statusCode, retryable = false, retryAfterMs = null, upstreamStatus = null, upstreamCode = null, streamStarted = false } = {}) {
    super(message, statusCode ?? HTTP_STATUS[code] ?? 502, code);
    this.name = 'AiProviderError';
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.upstreamStatus = upstreamStatus;
    this.upstreamCode = upstreamCode;
    this.streamStarted = streamStarted;
  }
}

const HTTP_STATUS = {
  [C.NOT_CONFIGURED]: 503,
  [C.DISABLED]: 403,
  [C.RATE_LIMITED]: 429,
  [C.TIMEOUT]: 504,
  [C.UNAVAILABLE]: 503,
  [C.AUTH]: 502,
  [C.CONTEXT_TOO_LONG]: 413,
  [C.CONTENT_FILTERED]: 422,
  [C.TOOL_ERROR]: 502,
  [C.BAD_REQUEST]: 502,
  [C.ABORTED]: 499,
  [C.INVALID_RESPONSE]: 502,
  [C.SERVICE_UNAVAILABLE]: 503,
  [C.SERVICE_TIMEOUT]: 504,
  [C.SERVICE_AUTH]: 502,
  [C.SERVICE_PROTOCOL]: 502,
  [C.RETRIEVAL_UNAVAILABLE]: 503,
  [C.KNOWLEDGE_NOT_READY]: 503,
};

// User-safe wording. Operator-only problems say so without leaking details.
const MESSAGES = {
  [C.NOT_CONFIGURED]: 'AI is not configured on this server',
  [C.DISABLED]: 'AI is not enabled for this organization',
  [C.RATE_LIMITED]: 'The AI service is busy. Please try again shortly',
  [C.TIMEOUT]: 'The AI service took too long to respond',
  [C.UNAVAILABLE]: 'The AI service is temporarily unavailable',
  [C.AUTH]: 'The AI service rejected this server\'s credentials',
  [C.CONTEXT_TOO_LONG]: 'This request is too long for the AI model',
  [C.CONTENT_FILTERED]: 'The AI service declined to answer this request',
  [C.TOOL_ERROR]: 'The AI model produced an invalid action. Please try again',
  [C.BAD_REQUEST]: 'The AI request was rejected',
  [C.ABORTED]: 'The AI request was cancelled',
  [C.INVALID_RESPONSE]: 'The AI service returned an unreadable response',
  [C.SERVICE_UNAVAILABLE]: 'The AI service is temporarily unavailable',
  [C.SERVICE_TIMEOUT]: 'The AI service took too long to respond',
  [C.SERVICE_AUTH]: 'The AI service rejected this server\'s credentials',
  [C.SERVICE_PROTOCOL]: 'The AI service returned an unreadable response',
  [C.RETRIEVAL_UNAVAILABLE]: 'Searching your documents is temporarily unavailable',
  [C.KNOWLEDGE_NOT_READY]: 'The document search index is not ready yet',
};

function make(code, options) {
  return new AiProviderError(code, MESSAGES[code], options);
}

function parseRetryAfter(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * Maps an HTTP failure from an OpenAI-compatible API. `payload` is the parsed
 * JSON body if any; only its machine-readable `code`/`type` are ever used.
 */
function fromHttpResponse(status, payload, headers) {
  const err = payload && typeof payload === 'object' ? payload.error || {} : {};
  const upstreamCode = typeof err.code === 'string' ? err.code.slice(0, 80) : typeof err.type === 'string' ? err.type.slice(0, 80) : null;
  const text = `${err.code || ''} ${err.type || ''} ${err.message || ''}`.toLowerCase();
  const base = { upstreamStatus: status, upstreamCode, retryAfterMs: parseRetryAfter(headers) };

  if (status === 401 || status === 403) return make(C.AUTH, base);
  if (status === 429) return make(C.RATE_LIMITED, { ...base, retryable: true });
  if (status === 413 || /context[_ ]length|maximum context|too many tokens|reduce the length/.test(text)) return make(C.CONTEXT_TOO_LONG, base);
  if (/tool_use_failed|failed to call a function|invalid.*tool/.test(text)) return make(C.TOOL_ERROR, base);
  if (/content[_ ]filter|content_policy|safety/.test(text)) return make(C.CONTENT_FILTERED, base);
  if (status === 408 || status >= 500) return make(C.UNAVAILABLE, { ...base, retryable: true });
  if (status >= 400) return make(C.BAD_REQUEST, base);
  return make(C.INVALID_RESPONSE, base);
}

module.exports = { AiProviderError, fromHttpResponse, make, parseRetryAfter };
