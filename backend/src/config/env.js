const path = require('path');
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function asList(value, fallback = []) {
  if (!value) {
    return fallback;
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function asPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function asNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

module.exports = {
  // ---- AI ----
  // The LLM provider key and model routing live ONLY in the Python AI service (ai/.env); Node never holds them.
  AI_GLOBAL_ENABLED: asBoolean(process.env.AI_GLOBAL_ENABLED, true), // platform kill switch
  AI_MAX_OUTPUT_TOKENS: asPositiveInt(process.env.AI_MAX_OUTPUT_TOKENS, 2048),
  AI_RATE_LIMIT_PER_MINUTE: asPositiveInt(process.env.AI_RATE_LIMIT_PER_MINUTE, 20), // AI requests per user per minute
  AI_MAX_CONCURRENT_PER_USER: asPositiveInt(process.env.AI_MAX_CONCURRENT_PER_USER, 3), // simultaneous in-flight AI requests per user
  AI_REDIS_PREFIX: process.env.AI_REDIS_PREFIX || 'ai', // Redis key prefix for AI limits/quotas (tests override)
  AI_USAGE_RETENTION_DAYS: asPositiveInt(process.env.AI_USAGE_RETENTION_DAYS, 395), // usage events are deleted after this
  AI_RESERVATION_TTL_SECONDS: asPositiveInt(process.env.AI_RESERVATION_TTL_SECONDS, 900), // must exceed the longest possible request
  // --- Python AI service (the only component that talks to the LLM provider) ---
  AI_SERVICE_URL: (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/+$/, ''),
  AI_SERVICE_SIGNING_KEY: process.env.AI_SERVICE_SIGNING_KEY || '', // ES256 private key (PEM or base64 of PEM); Node only
  AI_SERVICE_SIGNING_KEY_FILE: process.env.AI_SERVICE_SIGNING_KEY_FILE || '',
  AI_SERVICE_KEY_ID: process.env.AI_SERVICE_KEY_ID || 'v1',
  AI_SERVICE_CONNECT_TIMEOUT_MS: asPositiveInt(process.env.AI_SERVICE_CONNECT_TIMEOUT_MS, 5000), // until response headers
  AI_SERVICE_FIRST_FRAME_TIMEOUT_MS: asPositiveInt(process.env.AI_SERVICE_FIRST_FRAME_TIMEOUT_MS, 30000), // headers -> first frame (Python retries Groq inside this)
  AI_SERVICE_IDLE_TIMEOUT_MS: asPositiveInt(process.env.AI_SERVICE_IDLE_TIMEOUT_MS, 35000), // silence between frames
  // Deploy-time ACTIVATION of live tools for conversations. Default OFF: nothing opens a tool budget for real users until this is deliberately set. (The runtime EMERGENCY switch is separate: aiPlatformControl.)
  AI_LIVE_TOOLS_ENABLED: process.env.AI_LIVE_TOOLS_ENABLED === 'true',
  AI_REQUEST_CEILING_MS: asPositiveInt(process.env.AI_REQUEST_CEILING_MS, 120000), // hard cap for one request; sizes the in-flight slot and callback token
  AI_SERVICE_STATUS_TTL_MS: asPositiveInt(process.env.AI_SERVICE_STATUS_TTL_MS, 15000), // how long a readiness answer is trusted
  AI_INTERNAL_HOST: process.env.AI_INTERNAL_HOST || '127.0.0.1', // internal callback listener (never the public port)
  AI_INTERNAL_PORT: Number(process.env.AI_INTERNAL_PORT) || 5002,
  // --- Document ingestion (Phase 3) ---
  AI_WORKER_PUBLIC_KEY: process.env.AI_WORKER_PUBLIC_KEY || '', // ES256 PUBLIC key of the Python worker (PEM or base64 PEM)
  AI_WORKER_PUBLIC_KEY_FILE: process.env.AI_WORKER_PUBLIC_KEY_FILE || '',
  AI_WORKER_KEY_ID: process.env.AI_WORKER_KEY_ID || 'w1',
  AI_INGEST_MAX_FILE_MB: asPositiveInt(process.env.AI_INGEST_MAX_FILE_MB, 25), // larger files are skipped (FILE_TOO_LARGE) without a worker
  AI_INGEST_LEASE_SECONDS: asPositiveInt(process.env.AI_INGEST_LEASE_SECONDS, 120), // a claim lasts this long unless heartbeated
  AI_INGEST_MAX_PROCESSING_SECONDS: asPositiveInt(process.env.AI_INGEST_MAX_PROCESSING_SECONDS, 900), // heartbeats cannot extend past this
  AI_INGEST_MAX_ATTEMPTS: asPositiveInt(process.env.AI_INGEST_MAX_ATTEMPTS, 5),
  AI_INGEST_BACKOFF_BASE_SECONDS: asPositiveInt(process.env.AI_INGEST_BACKOFF_BASE_SECONDS, 30),
  AI_INGEST_BACKOFF_MAX_SECONDS: asPositiveInt(process.env.AI_INGEST_BACKOFF_MAX_SECONDS, 1800),
  AI_INGEST_SWEEP_BATCH: asPositiveInt(process.env.AI_INGEST_SWEEP_BATCH, 200), // documents examined per org per sweep
  // --- Retrieval (Phase 5). Search limits live in the Python service; Node sizes the quota reservation and the question. ---
  AI_RAG_CONTEXT_TOKENS: asPositiveInt(process.env.AI_RAG_CONTEXT_TOKENS, 3000), // must match the Python context budget: reserved up front, settled to real usage
  AI_RAG_MAX_QUESTION_CHARS: asPositiveInt(process.env.AI_RAG_MAX_QUESTION_CHARS, 2000),
  AI_RAG_AUTHORIZE_MAX_CANDIDATES: asPositiveInt(process.env.AI_RAG_AUTHORIZE_MAX_CANDIDATES, 50), // per authorization call
  // --- Live data tools (Phase 8): tighter limits INSIDE the request ceiling (AI_REQUEST_CEILING_MS). Enforced by Node, per request. ---
  AI_TOOL_MAX_ROUNDS: asPositiveInt(process.env.AI_TOOL_MAX_ROUNDS, 3), // model rounds that may request tools (a final answer round follows)
  AI_TOOL_MAX_CALLS: asPositiveInt(process.env.AI_TOOL_MAX_CALLS, 5), // tool executions per request
  AI_TOOL_MAX_CONCURRENT: asPositiveInt(process.env.AI_TOOL_MAX_CONCURRENT, 2),
  AI_TOOL_TIMEOUT_MS: asPositiveInt(process.env.AI_TOOL_TIMEOUT_MS, 8000), // one execution
  AI_TOOL_TOTAL_MS: asPositiveInt(process.env.AI_TOOL_TOTAL_MS, 20000), // all executions of one request
  AI_TOOL_MAX_RESULT_BYTES: asPositiveInt(process.env.AI_TOOL_MAX_RESULT_BYTES, 6144), // serialized result, after projection
  AI_TOOL_MAX_RECORDS: asPositiveInt(process.env.AI_TOOL_MAX_RECORDS, 50), // longest array anywhere in a result
  AI_TOOL_MAX_STRING_CHARS: asPositiveInt(process.env.AI_TOOL_MAX_STRING_CHARS, 200),
  AI_TOOL_MAX_DEPTH: asPositiveInt(process.env.AI_TOOL_MAX_DEPTH, 4),
  // --- Conversations (Phase 6) ---
  AI_CONVERSATION_RETENTION_DAYS: asNonNegativeInt(process.env.AI_CONVERSATION_RETENTION_DAYS, 365), // days of inactivity before an active conversation is purged; 0 = keep forever
  AI_CONVERSATION_ARCHIVED_RETENTION_DAYS: asNonNegativeInt(process.env.AI_CONVERSATION_ARCHIVED_RETENTION_DAYS, 90), // days after archiving; 0 = keep forever
  AI_CONVERSATION_MAX_MESSAGES: asPositiveInt(process.env.AI_CONVERSATION_MAX_MESSAGES, 200), // per conversation (user + assistant)
  AI_CONVERSATION_MAX_PER_USER: asPositiveInt(process.env.AI_CONVERSATION_MAX_PER_USER, 500),
  AI_CONVERSATION_LEASE_SECONDS: asPositiveInt(process.env.AI_CONVERSATION_LEASE_SECONDS, 300), // one reply at a time; a lease past this is treated as a crashed request
  AI_CONVERSATION_HISTORY_TURNS: asPositiveInt(process.env.AI_CONVERSATION_HISTORY_TURNS, 3), // earlier exchanges used to understand a follow-up
  AI_RAG_AUTHORIZED_TTL_SECONDS: asPositiveInt(process.env.AI_RAG_AUTHORIZED_TTL_SECONDS, 300), // how long a request's authorized chunk ids are remembered for citation checks
  // --- Embeddings / vector index (Phase 4). Node never holds Qdrant settings: only the Python embedding worker does. ---
  AI_EMBEDDING_SPACE: process.env.AI_EMBEDDING_SPACE || 'multilingual-e5-small', // which embedding space workers are producing
  AI_EMBEDDING_LEASE_SECONDS: asPositiveInt(process.env.AI_EMBEDDING_LEASE_SECONDS, 120),
  AI_EMBEDDING_MAX_PROCESSING_SECONDS: asPositiveInt(process.env.AI_EMBEDDING_MAX_PROCESSING_SECONDS, 900),
  AI_EMBEDDING_MAX_ATTEMPTS: asPositiveInt(process.env.AI_EMBEDDING_MAX_ATTEMPTS, 5),
  AI_EMBEDDING_BACKOFF_BASE_SECONDS: asPositiveInt(process.env.AI_EMBEDDING_BACKOFF_BASE_SECONDS, 30),
  AI_EMBEDDING_BACKOFF_MAX_SECONDS: asPositiveInt(process.env.AI_EMBEDDING_BACKOFF_MAX_SECONDS, 1800),
  AI_EMBEDDING_VERIFY_DAYS: asPositiveInt(process.env.AI_EMBEDDING_VERIFY_DAYS, 7), // completed jobs are re-verified against the index this often
  AI_EMBEDDING_VERIFY_BATCH: asPositiveInt(process.env.AI_EMBEDDING_VERIFY_BATCH, 20), // ... at most this many per sweep
  AI_EMBEDDING_RETIRE_GRACE_HOURS: asPositiveInt(process.env.AI_EMBEDDING_RETIRE_GRACE_HOURS, 24), // the previous space survives this long after a promotion
  // Optional JSON overriding/adding prices: {"model-id":{"input":0.15,"output":0.6}} in USD per 1M tokens.
  AI_PRICING_JSON: process.env.AI_PRICING_JSON || '',
  // Tokens one plan "AI credit" is worth. Unset = AI credits are not enforced (no such unit exists until this is configured).
  AI_TOKENS_PER_CREDIT: Number(process.env.AI_TOKENS_PER_CREDIT) > 0 ? Number(process.env.AI_TOKENS_PER_CREDIT) : null,
  CLIENT_ORIGINS: asList(process.env.CLIENT_URL, ['http://localhost:3000', 'http://127.0.0.1:3000']),
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:3000',
  AUTH_ACCESS_COOKIE_NAME: process.env.AUTH_ACCESS_COOKIE_NAME || 'sync_access_token',
  AUTH_CSRF_COOKIE_NAME: process.env.AUTH_CSRF_COOKIE_NAME || 'sync_csrf_token',
  AUTH_REFRESH_COOKIE_NAME: process.env.AUTH_REFRESH_COOKIE_NAME || 'sync_refresh_token',
  AUTH_SESSION_COOKIE_NAME: process.env.AUTH_SESSION_COOKIE_NAME || 'sync.sid',
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  JWT_SECRET: required('JWT_SECRET'),
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || '',
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || '',
  LIVEKIT_URL: process.env.LIVEKIT_URL || '',
  LIVEKIT_WEBHOOK_ENABLED: asBoolean(process.env.LIVEKIT_WEBHOOK_ENABLED, false),
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || 'Sync Os',
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD || process.env.SMTP_PASS || '',
  EMAIL_SERVICE: process.env.EMAIL_SERVICE || 'gmail',
  EMAIL_USER: process.env.EMAIL_USER || process.env.SMTP_USER || '',
  MONGO_URI: required('MONGO_URI'),
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 5000),
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  STORAGE_DRIVER: process.env.STORAGE_DRIVER || 'local',
  STORAGE_LOCAL_ROOT: process.env.STORAGE_LOCAL_ROOT || path.join(__dirname, '..', '..', 'uploads', 'documents'),
  UPLOAD_TMP_DIR: process.env.UPLOAD_TMP_DIR || path.join(__dirname, '..', '..', 'uploads', 'tmp'),
  DOCUMENT_MAX_FILE_SIZE_MB: Number(process.env.DOCUMENT_MAX_FILE_SIZE_MB || 25),
  // Redis key/channel prefixes — overridable so test runs never touch a dev worker's queue.
  EMAIL_QUEUE_PREFIX: process.env.EMAIL_QUEUE_PREFIX || 'email',
  NOTIFICATION_CHANNEL_PREFIX: process.env.NOTIFICATION_CHANNEL_PREFIX || 'notif',
  NOTIFICATION_RETENTION_DAYS: Number(process.env.NOTIFICATION_RETENTION_DAYS || 90),
  SESSION_SECRET: process.env.SESSION_SECRET || process.env.JWT_SECRET,
  SMTP_FROM: process.env.SMTP_FROM || 'Sync Os <no-reply@syncos.local>',
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_PORT: Number(process.env.SMTP_PORT || 587),
  SMTP_SECURE: asBoolean(process.env.SMTP_SECURE, false),
  SMTP_USER: process.env.SMTP_USER || '',
};
