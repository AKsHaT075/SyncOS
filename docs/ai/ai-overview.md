# AI service

Status: document question answering with citations, private conversations and the AI Studio UI are built. Live workspace lookups (read-only tools) are implemented but switched off by default (`AI_LIVE_TOOLS_ENABLED`). Write proposals are not built. The embedding model is `intfloat/multilingual-e5-small`.

```
Browser ─► Next.js ─► Node backend (authority) ─► Python AI service (FastAPI) ─► Groq
                            ▲                              │
                            └── callbacks (scoped token) ──┘
```

The wire contract, token model and fixtures are in **[`docs/ai/ai-service-contract.md`](ai-service-contract.md)**.
That file is the source of truth for the Node⇄Python boundary; this one covers the Node side.

## Decisions (approved)

- LLM inference: **Groq only** in v1. No OpenAI/Gemini code, **no automatic fallback**. The adapter lives in Python (`ai/app/providers/groq.py`).
- Groq does **not** provide embeddings or vector storage. The embedding provider is a separate, still-open decision (needed in Phase 4).
- Vectors: Mongo-exact `VectorStore` (strict limits, measured), Qdrant as a possible later scale-out. *planned*
- The Groq key lives **only in the Python service's environment**. Node, Next.js and the browser never see it; it is never stored in a database, returned by an API or logged. No per-org BYOK.
- AI is **off by default** per organization. An org-admin/admin enables it after accepting a disclosure.
- Guests: no AI. Super-admin: platform status/usage only, never tenant content.
- Writes by AI (planned): proposals only, executed through a protected confirmation endpoint. Permanently read-only: deletes, role/permission changes, blocking/removal, org settings, sharing/visibility changes, asset assignment, credentials.

## Who owns what

| Concern | Node | Python |
|---|---|---|
| Authentication, sessions, RBAC, org isolation, `orgBlocked` | **yes** | no |
| AI on/off per org, disclosure, kill switch | **yes** | no |
| Rate limit, concurrency, user/org quotas, reservation + settlement | **yes** | no |
| Durable usage events, audit, cost estimate (`pricing.js`) | **yes** | reports tokens + model only |
| Tool registry, per-user tool permission, argument validation, running tools | **yes** | no (asks Node) |
| Groq key, model choice, prompts, retries, timeouts, SSE parsing | no | **yes** |
| Tool-loop / RAG orchestration, extraction, chunking, embeddings (later) | no | **yes** |

Python holds no RBAC. Node holds no provider credentials.

## Node code map (`backend/src/`)

| File | Role |
|---|---|
| `services/ai/aiService/tokens.js` | Signs generate/status/callback JWTs (ES256 only); verifies callback tokens. |
| `services/ai/aiService/client.js` | The HTTP/SSE client for Python. Same event contract the pipeline always had. **Never retries.** |
| `services/ai/aiService/index.js` | Engine seam (`setEngine` for tests), cached readiness probe (`platformStatus`), `collectEvents`. |
| `services/ai/aiService/errors.js`, `sse.js` | Normalized `AiProviderError`; SSE frame reader. |
| `services/ai/aiPipeline.service.js` | gate → admit → reserve → **call Python** → settle → record → release. |
| `services/ai/aiLimits.service.js`, `aiUsageRecorder.service.js`, `aiJobs.js` | Redis Lua limits/quotas; durable usage (+ outbox). `isInFlight` backs the callback gate. |
| `services/ai/aiSettings.service.js` | `assertAiAvailable` and org settings. |
| `services/ai/aiUsage.service.js` | Usage reports (me / org / platform). |
| `services/ai/aiCallbacks.service.js`, `aiToolRegistry.js` | Independent authorization of every tool callback. Registry is **empty** until Phase 8. |
| `internalApp.js` | The internal callback listener (`AI_INTERNAL_HOST:AI_INTERNAL_PORT`, default `127.0.0.1:5002`). |
| `services/ai/pricing.js` | Price table, `estimateCostMicros`, `pricingVersion`. |

## Trust model (summary; details in the contract)

- **Tokens:** ES256 only; Node signs, Python verifies with a public key, so a compromised Python cannot mint user context. `alg=none`, HS*, RS*, unknown/missing `kid`, wrong audience, missing `jti/exp/iat/nbf`, lifetime over the cap, malformed ids are all rejected (pytest `test_security.py`, 39 cases).
- **Separate audiences:** `syncos-ai:generate`, `syncos-ai:status`, `syncos-node:callback`. A token for one purpose fails for the others.
- **Minimal claims:** `sub` (user id), `org` (org id), `jti` (= request key), `mo` (max output tokens). No role, permissions, name or email. The request body schema has no identity fields (`extra=forbid`).
- **Single use:** Python consumes each generate token's `jti` atomically in **Redis** (`SET NX EX`), so replay is refused across any number of replicas, and refused outright if Redis is down. In-memory replay is allowed only with `AI_REPLAY_STORE=memory` **and** `AI_SINGLE_INSTANCE=true`; otherwise Python refuses to start.
- **Callbacks:** a callback token is honoured only while its request is in Node's in-flight set, the user is re-loaded fresh each time, the AI gate is re-run, and the tool is looked up in **Node's** registry with the user's permission. Unknown tool, forbidden tool and non-executable tool are the same `404`. Python's tool list is never an authorization boundary. No callback token is issued on the generate path yet (Python cannot call back until Phase 8); the verification gate is built and tested with tokens minted in the tests.
- **Network:** Python binds to `127.0.0.1` by default; callbacks use a separate Node listener. Neither is on the public port. No docs/openapi on Python.
- **Logging:** neither side logs prompts, completions, tokens or keys (asserted in tests against real Python logs).

## Exactly-once settlement

One Node request = one `requestKey` (also the token `jti`) = one reservation = one settlement. Settlement is Node-only; the settle script deletes the reservation atomically so a repeat is a no-op. Python's Groq retries are invisible and produce one `usage` frame. Node never re-sends a generate request. Charges: real usage wins; success without usage → estimate; error/cancel/truncation before output → 0; after output → estimate (flagged). Verified in `ai-service-flow.test.js` (stub service) and `ai-cross-process.test.js` (real Python, incl. Python killed mid-stream and client abort propagating to the Groq connection).

**Known limit:** if Python spent Groq tokens but nothing reached Node (e.g. the connection dies before the first frame), Node charges 0. Bounded by one request.

## Permissions (exact assignment)

| Permission | org-admin / admin | hr | manager | employee | guest | super-admin |
|---|---|---|---|---|---|---|
| `USE_AI` | yes | yes | yes | yes | **no** | **no** |
| `MANAGE_AI` (enable/disable, quotas) | yes | no | no | no | no | no |
| `VIEW_AI_USAGE` (org-wide usage) | yes | no | no | no | no | no |
| `MANAGE_AI_KNOWLEDGE` (index admin) | yes | no | no | no | no | no |


## Configuration

**Node (`backend/.env`)** — no provider settings any more (`GROQ_*`, `AI_PROVIDER`, `AI_MODEL_*`, provider timeouts/retries were removed).

| Variable | Default | Meaning |
|---|---|---|
| `AI_GLOBAL_ENABLED` | `true` | Platform kill switch (read live on every request). |
| `AI_SERVICE_URL` | `http://127.0.0.1:8001` | Python service. |
| `AI_SERVICE_SIGNING_KEY` / `_FILE` | _(none = AI unavailable)_ | ES256 **private** key (PEM or base64 PEM). Node only. |
| `AI_SERVICE_KEY_ID` | `v1` | `kid` header; must exist in Python's key set. |
| `AI_SERVICE_CONNECT_TIMEOUT_MS` / `_FIRST_FRAME_TIMEOUT_MS` / `_IDLE_TIMEOUT_MS` | 5000 / 30000 / 35000 | Hop timers. |
| `AI_REQUEST_CEILING_MS` | `120000` | Hard cap per request; sizes the in-flight slot and callback token. |
| `AI_SERVICE_STATUS_TTL_MS` | `15000` | How long a readiness answer is trusted (failures: 3 s). |
| `AI_INTERNAL_HOST` / `AI_INTERNAL_PORT` | `127.0.0.1` / `5002` | Callback listener. |
| `AI_MAX_OUTPUT_TOKENS` | `2048` | Cap Node asks for (carried in the signed token; Python can only lower it). |
| `AI_RATE_LIMIT_PER_MINUTE`, `AI_MAX_CONCURRENT_PER_USER` | 20, 3 | Per-user limits. |
| `AI_REDIS_PREFIX`, `AI_RESERVATION_TTL_SECONDS`, `AI_USAGE_RETENTION_DAYS`, `AI_PRICING_JSON` | | unchanged from Phase 2. |

**Ingestion (Node):** `AI_WORKER_PUBLIC_KEY[_FILE]`, `AI_WORKER_KEY_ID` (`w1`), `AI_INGEST_MAX_FILE_MB` (25), `AI_INGEST_LEASE_SECONDS` (120), `AI_INGEST_MAX_PROCESSING_SECONDS` (900), `AI_INGEST_MAX_ATTEMPTS` (5), `AI_INGEST_BACKOFF_BASE_SECONDS` (30), `AI_INGEST_BACKOFF_MAX_SECONDS` (1800), `AI_INGEST_SWEEP_BATCH` (200). **Ingestion (worker, `ai/.env`):** `AI_WORKER_SIGNING_KEY[_FILE]`, `AI_WORKER_KEY_ID`, `AI_NODE_INTERNAL_URL`, `AI_WORKER_ID`, `AI_INGEST_*` limits/timeouts.

**Embeddings (Node):** `AI_EMBEDDING_SPACE` (`multilingual-e5-small`), `AI_EMBEDDING_LEASE_SECONDS` (120), `AI_EMBEDDING_MAX_PROCESSING_SECONDS` (900), `AI_EMBEDDING_MAX_ATTEMPTS` (5), `AI_EMBEDDING_BACKOFF_BASE_SECONDS`/`_MAX_SECONDS` (30/1800), `AI_EMBEDDING_VERIFY_DAYS` (7), `AI_EMBEDDING_VERIFY_BATCH` (20), `AI_EMBEDDING_RETIRE_GRACE_HOURS` (24). **Embeddings (worker, `ai/.env`):** `AI_EMBEDDING_PROVIDER`, `AI_EMBEDDING_CACHE_DIR`, `AI_EMBEDDING_OFFLINE`, `AI_EMBEDDING_THREADS`, `AI_EMBEDDING_BATCH_SIZE`, `AI_EMBEDDING_PAGE_SIZE`, `AI_EMBEDDING_MODEL_PATH`, `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_PATH`, `QDRANT_COLLECTION_PREFIX`, `QDRANT_TIMEOUT_SECONDS`, `AI_ENVIRONMENT`.

**Python (`ai/.env`, see `ai/.env.example`)** — `GROQ_API_KEY`, `GROQ_BASE_URL`, `AI_MODEL_CHAT/_SUMMARIZE`, provider timeouts/retries, `AI_JWT_PUBLIC_KEY(_FILE)`/`AI_JWT_KEY_ID`/`AI_JWT_PUBLIC_KEYS`, `AI_REPLAY_STORE`, `AI_SINGLE_INSTANCE`, `REDIS_URL`, `AI_REDIS_PREFIX`, `HOST`, `PORT`.

Generate a key pair: `node backend/scripts/generate-ai-keys.js` (writes `ai/keys/`, gitignored, prints the env lines).

Model ids and prices came from Groq's public docs and **were not verified with a live call** (no key was available).

## Organization settings (`/api/v1/ai`)

No row = disabled. `GET /status` (`USE_AI`), `GET /disclosure`, `GET /settings`, `PUT /settings` (`MANAGE_AI`), `GET /usage/me` (`USE_AI`), `GET /usage` (`VIEW_AI_USAGE`), `GET /platform/status` and `/platform/usage` (super-admin, aggregates only). `status.reason`: `NO_ACCESS`, `PLATFORM_DISABLED`, `NOT_CONFIGURED` (also when the AI service is unreachable, rejects our key, or has no Groq key), `ORG_DISABLED`.

`assertAiAvailable({ actor })` is the single gate (role permission, kill switch, AI service ready, org flag), evaluated live. Audit events: `ai.enabled`, `ai.disabled`, `ai.settings_updated` (quota `from`/`to`).

Known limitation: a disclosure version bump flags `needsReacceptance` but does not auto-disable AI.

## Phase 3: document ingestion and extraction

Full wire contract: `docs/ai/ai-service-contract.md` §11. Summary of the Node side:

| File | Role |
|---|---|
| `models/DocumentIngestionJob.js` | One row per (org, document, version, pipelineVersion) — unique index. Status, reason code, attempts, lease, counts. **No text.** |
| `models/DocumentChunk.js` | Chunk text + hash + token estimate + `location`. No ACL data, no embedding fields (Phase 4). |
| `constants/ingestion.constants.js` | Statuses, formats, reason codes + admin messages, limits. Mirrored in `ai/contracts/ingestion.json`. |
| `services/ai/ingestion/ingestionJobs.service.js` | enqueue (upsert), atomic claim, heartbeat, fail/skip (lock-fenced), stale recovery, admin retry, listing. |
| `services/ai/ingestion/ingestionWorkerApi.service.js` | What the worker may do: claim, content stream, heartbeat, validated result + idempotent chunk writes. |
| `services/ai/ingestion/ingestionWorkerAuth.js` | ES256 worker tokens (worker signs, Node verifies), single-use jti in Redis. |
| `services/ai/ingestion/ingestionReconcile.service.js` | Back-fill, checksum-drift repair, supersession, trashed-document cleanup, stale chunk removal; periodic + on demand. |
| `services/ai/ingestion/ingestionAdmin.service.js` | `/api/v1/ai/knowledge/ingestion*` (`MANAGE_AI_KNOWLEDGE`): overview, jobs, retry, reconcile. Ids/statuses only — **never document names or text**. |
| `internalApp.js` | `/internal/ingestion/*` next to the callback route, on the loopback listener. |
| hooks | `document.service` (upload, trash), `documentVersion.service` (new/restored version), `documentTrash.service` (restore, purge): one best-effort call each; ingestion can never fail the user's action. |

**Lifecycle.** `queued → processing → indexed | skipped | failed → (backoff) → … → dead`. Claim is one conditional
`findOneAndUpdate` (no double claims under concurrency). A lease (`AI_INGEST_LEASE_SECONDS`, default 120 s) is extended by
heartbeats up to `AI_INGEST_MAX_PROCESSING_SECONDS`; a lapsed lease is recovered every minute (and on every claim) to `failed`
or, when attempts are exhausted, `dead`. Backoff = `base·2^(attempt-1)` capped, jittered (`AI_INGEST_BACKOFF_*`, default 30 s → 30 min),
`AI_INGEST_MAX_ATTEMPTS` default 5. Administrators can retry `dead`/`failed`/`skipped` jobs of the **current** version.
Unsupported types and oversized files are recorded as `skipped` by Node without involving a worker. Only AI-enabled
organizations are ingested; the periodic sweep (≈10 min, Redis-locked) back-fills when AI is switched on.

**Extraction (Python, `ai/app/ingestion/`).** PDF (`pypdf`, text only), DOCX (`python-docx`: headings → `headingPath`, paragraphs, tables),
XLSX (`openpyxl` read-only streaming, visible sheets, cached values, header row repeated in each chunk), PPTX (`python-pptx`: slide text, tables,
groups; speaker notes are **not** indexed), TXT (UTF-8/UTF-16/cp1252), CSV (delimiter sniffing, header-aware rows). Skipped with a reason:
scanned/image-only PDFs (`NO_EXTRACTABLE_TEXT`, no OCR), encrypted PDFs and password-protected Office files (`ENCRYPTED`), empty, corrupt,
legacy DOC/XLS/PPT, ZIP, images.

**Safety.** Every extraction runs in a **spawned child process** with a wall-clock kill, CPU limit and (Linux) address-space limit; the
child inherits no secrets. OOXML files are pre-inspected from the zip central directory only (entry count, per-entry and total
uncompressed size, compression ratio, encryption flag, path traversal, required parts) before any parser sees them. Extracted text,
chunk count, rows, cells, sheets, slides and pages are capped. Downloaded bytes live in a `0600` temp file removed after every job; a
startup sweep removes leftovers of crashed workers. Neither side logs content, names or tokens (asserted in tests).

**Chunking.** Sizes are **approximate tokens = chars ÷ 4** (not a tokenizer; poor for CJK/code): target ~600, min ~400, max ~800, overlap 12% of
target. Whole blocks (paragraph, table row, slide) are never split unless one alone exceeds the maximum. A worksheet change always starts a
new chunk; a heading/slide change starts one once the current chunk is ≥ minimum (small slides merge, with a `slideStart…slideEnd` range).
Overlap is made of whole trailing blocks (or a word-boundary tail of an oversized block) and is not applied across section boundaries.
Chunks are deterministic, so re-ingestion rewrites identical rows. `location`: PDF `pageStart/End`, DOCX `headingPath`, XLSX `sheet` + `rowStart/End`,
PPTX `slideStart/End`, CSV `rowStart/End` (file rows), TXT `charStart/End` (offsets into the **normalized** text).

**Authorization boundary.** Chunks store no visibility. Phase 5 must authorize each chunk from the live `Document` and must treat a chunk as valid only
if its job is `indexed` for the document's current version and pipeline. Permission changes need no re-extraction. Private documents are
ingested (approved earlier) and remain owner-only at retrieval.

**Run it.** `node backend/scripts/generate-ai-keys.js` (creates both key pairs), then in `ai/`: `.venv/bin/python -m app.ingestion.worker` (needs only the worker
env vars in `ai/.env.example`; give it no Groq key). Several workers may run at once.

## Phase 4: embeddings and the vector store

Wire contract: `docs/ai/ai-service-contract.md` §12. Python (`ai/app/embeddings/`, `ai/app/vectorstore/`) embeds and writes vectors; Node
(`backend/src/services/ai/embedding/`) owns jobs, spaces and lifecycle and **never talks to Qdrant**.

**The model — evidence, not assumption.** `intfloat/multilingual-e5-small`: MIT licence; 384 dimensions; 512-token input window; mean
pooling + L2 normalization; mandatory `query: ` / `passage: ` prefixes (even for non-English text); ~118M parameters, 12 layers;
100 XLM-R languages (Hindi and Punjabi included, but the model card warns low-resource languages may degrade). It is **not** in
FastEmbed's built-in list (only e5-large is), so it is registered as a custom ONNX model and loaded from a snapshot **pinned to commit
`614241f6…`** (fp32 `onnx/model.onnx`, 470 MB; the repo's quantized files are CPU-specific and would be a different space). Measured here
(arm64, 16 GB): load ~1 s from cache, **~0.9-1.5 GB resident**, **24-34 ms per 340-token chunk** (~5 cores busy), unit-norm outputs.
Retrieval smoke test (6 hand-written policy passages per language, `ai/tests/eval/multilingual_corpus.json`, run by
`ai/scripts/benchmark_embeddings.py`): English 6/6, Punjabi 6/6, **Hindi 5/6** (one "work from home" query matched the "leave"
passage); an English query finds the Hindi passage on the same topic 4/6. That is a smoke test of 18 queries, **not a benchmark**: Hindi is
visibly the weakest of the three and mixed-language or very domain-specific text is untested. Phase 5 should not rely on vectors alone.
The space design makes a better model a supported migration, not a rewrite.

**Ingestion `p2` (chunks sized for the model).** p1 estimated tokens as chars ÷ 4, which under-counts Gurmukhi by ~30% (measured) and let
chunks exceed the 512-token window. p2 measures with the model's own tokenizer: target ~350, min ~230, max ~450 tokens, 12% overlap,
and a hard ceiling of 500 content tokens so that the `passage: ` prefix and `<s></s>` always fit. The embedder re-measures every input and
**refuses** (`EMBEDDING_INPUT_TOO_LONG`) rather than let FastEmbed truncate silently. p1 chunks stay in place until a document's p2 job is
indexed (then `dropObsoleteChunks` removes them), so the old index survives until each document's migration succeeds.

**Embedding spaces.** The id hashes model, revision, file, dimensions, pooling, normalization, both prefixes, max tokens, distance,
embedding pipeline (`e1`) and ingestion pipeline (`p2`); Node and Python compute identical ids (golden values in
`ai/contracts/embedding.json`, asserted in both suites). One Qdrant collection per space. `AiEmbeddingConfig` (one row) holds the
`active` / `target` / `retiring` space ids. **Migration**: change `AI_EMBEDDING_SPACE` (Node) and run workers for the new model; Node
starts a migration, fills the target beside the active space, and `POST /api/v1/ai/platform/embedding/migration/promote` (super-admin)
flips the pointer in one compare-and-swap only when coverage is complete and verified. The previous space stays for
`AI_EMBEDDING_RETIRE_GRACE_HOURS` (default 24), then is purged. A failed or abandoned migration never touches the active space.

**Node code map.** `models/{EmbeddingJob,AiEmbeddingConfig}.js`; `constants/embedding.constants.js`; `services/ai/embedding/`:
`embeddingSpaces` (config, coverage, validated promote/abandon), `embeddingJobs` (enqueue, atomic claim, lease, recovery, retry),
`embeddingWorkerApi` (claim, chunk pages, validated results), `embeddingReconcile` (back-fill, stale versions, orphans, verification,
retiring), `embeddingAdmin`, `index` (hooks). Hooks: extraction `indexed` ⇒ embed; `ingestion.documentsTrashed/Purged` ⇒ purge.
Internal routes `/internal/embedding/*` (audience `syncos-node:embedding`). Tenant admin API `/api/v1/ai/knowledge/embedding*`
(`MANAGE_AI_KNOWLEDGE`: overview, jobs, retry, reconcile, verify); platform API `/api/v1/ai/platform/embedding*` (super-admin: status,
promote, abandon, start). Responses carry ids, counts and statuses only.

**Job lifecycle.** `queued → processing → completed | skipped | failed → (backoff) → … → dead`, same discipline as ingestion
(atomic claim, lease + heartbeat, stale recovery, jittered exponential backoff, `AI_EMBEDDING_MAX_ATTEMPTS`, admin retry). Purges are claimed
first. `embed` is idempotent (deterministic point ids; unchanged chunks are not re-embedded; strays are deleted); `purge` is idempotent
(deleting nothing is success) and carries a `generation` so a re-request that raced a running purge is not lost.

**Security.** Python holds the Qdrant URL/API key; Node, Next.js and the browser never do. Every `VectorStore` call requires an
organization and filters on it; point ids embed the organization. Payload is `{organization, document, version, chunk_index, text_hash,
ingestion_pipeline, space}` — **no text, no permissions**, and never an authorization source (Phase 5 authorizes in Node from the live
Document). Chunk text reaches the worker only for a claimed embed job, after live checks (org-scoped, not trashed, current version,
extraction indexed, AI enabled). Vectors never pass through Node. Dimensions, finiteness and unit norm are validated before any write.
Python refuses to start with a non-loopback Qdrant without an API key and https, or with embedded/in-memory Qdrant in production
(`AI_ENVIRONMENT=production`), or with the fake provider in production. Neither side logs text, vectors or keys (asserted against real
worker logs).

**Operating it.** See `ai/README.md` ("Embeddings and Qdrant"): local development uses **embedded Qdrant** (`QDRANT_PATH`, no server, no
Docker, **single process only**) or a verified release binary (`ai/scripts/install_qdrant.py`); production needs a **private Qdrant
server with an API key and TLS**. Mongo is the source of truth: a lost Qdrant is rebuilt by re-queueing the jobs
(`POST /knowledge/embedding/verify` repairs gaps; resetting the space's jobs rebuilds it).

**Resources (measured, this machine).** Embedding worker ~1 GB RSS (plan ≥2 GB per worker) and ~30 chunks/s on ~5 cores; the model downloads
~470 MB once. Qdrant: 59 MB idle; 40,000 vectors ≈ 430 MB RSS / 280 MB disk, inserted at ~11k vectors/s, ~2 ms filtered search.

## Phase 5: RAG and permission-aware retrieval

- Public endpoint: `POST /api/v1/ai/ask` `{question}` (JSON, or SSE with `Accept: text/event-stream`/`?stream=1`). Requires `USE_AI`. Returns `{answer, citations[], unverifiedMarkers, droppedCitations, sourcesUsed}`; no raw retrieval internals reach the browser.
- Code: `services/ai/rag/{ask,knowledgeAccess}.service.js`, `aiCallbacks.authorizeKnowledge`, internal route `POST /internal/ai/knowledge/authorize` (`internalApp.js`), `aiService/client.js` (`rag` routes to `/internal/v1/answer`).
- Authorization is per request and live (see ai-service-contract.md section 13). Private documents are owner-only for AI, admins excluded. Stale versions, trashed documents, other orgs and chunks outside the active space are rejected before any text leaves Node.
- Metering: reserve = estimate + `AI_RAG_CONTEXT_TOKENS` + 600 overhead + output cap, settled to Groq's real usage; no-answer charges 0.
- Env (Node): `AI_RAG_CONTEXT_TOKENS`, `AI_RAG_MAX_QUESTION_CHARS`, `AI_RAG_AUTHORIZE_MAX_CANDIDATES`, `AI_RAG_AUTHORIZED_TTL_SECONDS`. Env (Python): `AI_RAG_ENABLED` (default false), `AI_NODE_INTERNAL_URL`, `AI_RAG_TOP_K|CANDIDATES|MAX_CANDIDATES|MIN_SCORE|SCORE_WINDOW|CONTEXT_TOKENS|MAX_PER_DOCUMENT|NEAR_DUPLICATE|AUTHORIZE_TIMEOUT_SECONDS|MAX_QUESTION_CHARS`.
- Ops: the API process now loads the E5 model (~1 GB RSS) and needs a Qdrant SERVER in dev (embedded Qdrant is single-process and conflicts with the embedding worker).
- Limitations: Hindi is the weakest language (one false no-answer at score 0.78); threshold is model-specific; prompt-injection defense is layered mitigation (delimiters, rules, no tools, citation filtering), not a guarantee; real Groq behaviour unverified; budget token counts are approximate.

## Language policy (v1: English only)

- Questions (`/ask` and conversations) are checked at the Node boundary (`utils/languagePolicy.js`): if more than 30% of the letters are outside the Latin script the question gets a fixed reply (`finishReason: unsupported_language`) - no retrieval, no model call, no usage row, nothing charged.
- It is a SCRIPT check, not language identification: romanized Hindi and other Latin-script languages are not detected (they usually just find nothing). Hindi/Punjabi retrieval is not promised.
- The embedding model and space are unchanged (no re-embedding). Hindi/Punjabi eval cases and the Python no-answer messages are kept for future work.

## Phase 6: conversations

- Models `AIConversation` (owner, title, status active|archived, lease, `nextSeq`) and `AiMessage` (seq, role, content, status streaming|complete|incomplete|error, citations, requestKey). Services in `services/ai/conversations/*`.
- API (`/api/v1/ai/conversations`, `USE_AI`): POST create, GET list (cursor, `status=active|archived`), GET/PATCH(title, archived)/DELETE `:id`, GET `:id/messages` (cursor pages back in time), POST `:id/messages` (JSON, or SSE with `Accept: text/event-stream`; events `meta`, `retrieval`, `text`, `usage`, `citations`, `done`).
- Privacy: addressed only as `{_id, organization, user}` from the session; anyone else (including org-admin, HR, other tenants) gets 404 `CONVERSATION_NOT_FOUND`; guests/super-admin have no `USE_AI`. No admin route exists. Content is never logged, audited or stored in usage events.
- One reply at a time per conversation (atomic lease, 409 `CONVERSATION_BUSY`; expires after `AI_CONVERSATION_LEASE_SECONDS`). Limits: `AI_CONVERSATION_MAX_MESSAGES` (200), `AI_CONVERSATION_MAX_PER_USER` (500).
- Turn: ownership -> language policy -> AI gate -> claim -> persist user message + `streaming` assistant message -> existing metered RAG pipeline (same request key links messages and the usage event) -> persist `complete` / `incomplete` (cancelled or cut off, partial text kept, no citations) / `error`. Failures before the first event are HTTP errors and leave no trace.
- Follow-ups: the last `AI_CONVERSATION_HISTORY_TURNS` (3) successful exchanges (trimmed, citation markers stripped) go to Python only to rewrite the question into a standalone one (one small extra Groq call, metered; reservation grows only when history exists). The answer prompt gets the rewritten question + freshly authorized sources only: history is never a source of facts, and retrieval authorization is unchanged and live.
- Citations are stored as confirmed and RE-AUTHORIZED at every read: revoked/trashed/private documents come back as `{n, available:false}` with no name or id; the shown name is the current one.
- Titles: deterministic (first question, <=60 chars), never from documents or model output; a user rename is final.
- Retention (hourly in `aiJobs`): `AI_CONVERSATION_RETENTION_DAYS` (365, inactivity) and `AI_CONVERSATION_ARCHIVED_RETENTION_DAYS` (90 since archiving); 0 = keep. Delete is permanent and cascades. Stale `streaming` replies are closed as `incomplete`.
- Limitations: assistant text already shown to a user stays in their own conversation after access is revoked (only citations are re-checked); no message-level delete/edit/regenerate; reply text is saved at the end (a process crash loses the partial text, the reply is marked incomplete); deleting mid-answer does not abort the model call, it just discards the result; titles are not LLM-written; `colleague`-style concurrent SSE + other calls from ONE browser tab are fine, the limit is only per-conversation.

## Phase 8 (in progress): live organizational data - Steps 0 and 1 only

Built so far: the organization switch and the hardened Node tool-callback gate. **No organizational data tool exists or is registered**; the production registry is still empty and Python still never calls it.

- **Switch** `AiOrgSettings.liveDataEnabled` (default false; missing field = false, no migration). Separate from `enabled`; effective only while `enabled` is true; turning AI off also turns it off (audited, and AI-on does not restore it). Enabling needs AI on and the SEPARATE `AI_LIVE_DATA_DISCLOSURE` (`acceptLiveDataDisclosureVersion`); the base disclosure version is unchanged, so existing orgs are not asked to re-accept. `MANAGE_AI` only. Audit: `ai.live_data_enabled|disabled`. `GET /ai/status` shows `liveDataEnabled`; `GET /ai/settings` and `/ai/disclosure` also return the live-data disclosure.
- **Gate** (`aiCallbacks.executeTool`), every callback: token, request in flight, fresh user, AI gate + `assertLiveDataAvailable` (USE_AI, aiEnabled, liveDataEnabled), registry + permission, argument validation, **tool budget**, execution under a deadline and abort signal, live-data re-check AFTER the run (switching it off mid-run discards the result), allowlist projection and limits, audit.
- **Tool budget** (`tools/toolBudget.service.js`): Redis, atomic. Opened only by the pipeline for a request admitted with `toolBudget: true`; no budget = the same 404 as an unknown tool. Limits per request: calls (5), concurrency (2), total tool time (20 s), duplicates (same tool + canonical arguments once). Per call 8 s, shrinking to the time the request has left. All inside the unchanged 120 s ceiling. Env: `AI_TOOL_MAX_ROUNDS|MAX_CALLS|MAX_CONCURRENT|TIMEOUT_MS|TOTAL_MS|MAX_RESULT_BYTES|MAX_RECORDS|MAX_STRING_CHARS|MAX_DEPTH`.
- **Results** (`tools/toolResult.js`): each tool MUST declare a strict `resultSchema` allowlist (registry refuses a tool without one). After projection: plain JSON only (no ObjectId/Date/documents/undefined/NaN), no `$`/dotted keys, no obviously sensitive key names, depth, string length, array length and serialized bytes checked. Violations are rejected (502), never truncated, and field names are not reported.
- **Cancellation**: the internal route aborts the run when the connection closes; the pipeline aborts every running tool of a request when it ends (`tools/toolRuns.js`); each run has its own deadline. Tools receive `signal` and `maxTimeMs` and must honour them (a tool that ignores the signal cannot hold the callback past the deadline, but its own work is only as stoppable as the tool makes it). The abort registry is in-process; across instances the Redis in-flight check stops new callbacks and deadlines bound old ones.
- **Quota**: a tool-capable request reserves `(R+1)*base + R*T + (R+1)*output` up front (`toolReservationTokens`), settled to the usage Python reports. A plain request is unchanged.
- **Audit** (`tools/toolAudit.js`): one `ai.tool_invoked` row per identified call, including refusals: tool, status, error code, duration, record count, bytes, requestKey, callId, argument KEY names, and argument values only for fields the tool declared safe (`auditFields`) AND that look like enums. Never questions, results or free text. Best-effort (a failed audit write is logged by name only). `AiUsageEvent` gains `toolCalls`, `toolMs`, `toolFailures`.
- **Browser events**: `forUser()` in the controller is now a whitelist; raw tool events and any unknown event are dropped.

### Phase 8 Step 2: AI-specific visibility and projections (no tool registered yet)

- `utils/aiAccess.js`: pure predicates + Mongo filter builders for projects, tasks, meetings, teams, people (`canAi*`, `buildAi*Filter`). SEPARATE from the product's access files (untouched). The one policy difference (D1): an org admin / admin has NO bypass of a PRIVATE resource: a private project is visible to its owner and listed members only; a private task only to its assignees, approvers and the project's Owner/Manager-role members; a task is only reachable through a project the user can see. Admins keep ordinary read access to non-private resources. Archived/deleted records, guests, blocked and inactive users match nothing. People: only active, non-blocked members of the same organization (stricter than the directory for admin/HR).
- `services/ai/tools/aiScope.js`: `resolveAiScope` (visible / member / managed project id sets, capped at 2000, `truncated` flag) and `findAi{Project,Task,Meeting,Team,Person}` which return the record or `null` (missing, malformed, foreign-organization and forbidden ids are indistinguishable). All queries accept `maxTimeMs`.
- `services/ai/tools/projections.js` + `projectionSchemas.js`: explicit-allowlist projections (task, project, roster entry, team, person, meeting, calendar entry) with strict zod schemas a future tool passes as `resultSchema`. Rows are FLAT (primitives only) so `{ data:[row], summary }` fits the Step 1 depth limit (4) without relaxing it. Free text is cleaned (control chars removed, whitespace collapsed, URLs replaced by "[link removed]", D5); links to live records are built from validated ids and are in-app paths only. `fitRows` trims a list to the result budget.
- Not implemented: any data tool. Calendar note for Step 3: do NOT reuse `calendarQuery.getCalendar` collectors for AI (its admin path sees every meeting/task); build schedule entries from the AI filters and project them with `projectCalendarEntry`.

### Phase 8 Step 3: the first two tools (`list_my_tasks`, `list_my_schedule`)

Exactly two tools are registered (`services/ai/tools/liveDataTools.js`, called once from `server.js`; requiring the registry alone is still empty). They run only through the Step 1 callback gate (the only code that calls a tool's `run`), only for a request with an open tool budget, and only while the organization has live data on.

- **Dates** (`utils/aiDateRanges.js`): Node computes every boundary in the user's zone (calendar preference -> organization -> IST, validated; the model can never pass a zone or date). Weeks are Monday-Sunday; `next_7_days` / `next_14_days` are whole local days starting today (today..+6 / today..+13). Date-only fields (task/project due dates) are compared as UTC-midnight values and never shifted; meeting timestamps are compared as instants, each local-midnight boundary converted separately (DST days of 23/25 h are correct). A meeting overlaps a range if it ends after the range starts and starts before it ends; a meeting with no end time is treated as one hour (and shown with `end: null`).
- **`list_my_tasks`** `{status?: status|open (default open), due?: overdue|today|next_7_days|this_week|none, relation?: assigned|approver|owner (default assigned), limit?: 1-20 (default 10)}`. Path: fresh actor -> `resolveAiScope` -> `buildAiTaskFilter` (AI visibility, no admin bypass) AND relation/status/due. `owner` = task owner field OR owner of the task's project. `overdue` = open and strictly before today (and never matches Completed/Cancelled). Dated tasks first (soonest), then undated (newest). Result `{data, summary{count,total,truncated,complete}, asOf{date,timeZone}, filters}`.
- **`list_my_schedule`** `{range?: today|next_7_days|this_week|next_14_days (default next_7_days), types?: [meeting|task|project]}`. Built from three narrow AI-filtered queries, NOT `getCalendar` (whose admin path sees every meeting/task): meetings I host or attend, in a project visible under the AI rules, not cancelled; my open assigned tasks due in range; deadlines of running projects I own or belong to. Standalone calendar events are not included yet. Max 30 entries, sorted by local day, all-day first, then start time.
- **Coverage honesty**: `summary.complete` is false when the 2000-visible-project cap was reached or a per-source cap was hit; `truncated` means more matched than shown. Lists are trimmed to the byte budget (whole rows).
- **Deadlines and cancellation**: every query gets `maxTimeMS`; a database time-limit error becomes `AI_TOOL_TIMEOUT`; the signal is checked before and after every query (`toolSupport.js`).
- **Audit**: `ai.tool_invoked` with tool, status, error code, counts, bytes and ONLY the enum arguments (`status, due, relation, limit, range`); the `types` array is reduced to its key name.
- Known limits: bare domains in titles are not caught by URL neutralization; a project name or title is still untrusted text; events are not in the schedule yet.

### Phase 8 Step 4: project and team tools (seven tools in all)

Added `list_projects`, `get_project_overview`, `list_project_members`, `list_project_tasks`, `get_team` (registered in `liveDataTools.js` with the two Step 3 tools; nothing else). Same rules: only through the callback gate, flat allowlist results, Step 2 AI visibility (no administrator bypass of private projects/tasks), `maxTimeMS` + abort checks.

- **Name resolution** (`tools/nameResolution.js`, `projectLookup.js`): a 24-hex reference is an id and goes through the `findAi*` helpers; anything else is a name, searched ONLY inside the AI visibility filter: exact (case-insensitive, via a collation, no regex) first, then a partial match with ESCAPED, length-limited text. One match is returned (`matchedBy: id|exact_name|partial_name`); several are `ambiguous` with at most 5 safe candidates (id, name, status, due, owner) taken only from the visible set; none/forbidden/foreign/malformed are one identical `not_found`. In production a unique case-insensitive (organization, name) index already prevents duplicate project names, so exact-name ambiguity is defence in depth; partial-name ambiguity is the realistic case.
- **Task counts** (`tools/taskCounts.js`): counts come from `buildAiTaskFilter`, the same filter `list_project_tasks` uses, so a count never includes a task the user cannot see (no analytics aggregation). Overdue = Step 3's definition. Project-specific tools use a scope of just the resolved project, so the 2,000-project cap cannot zero a count.
- `list_projects`: status (default all, never archived), overdue, `name_contains` (escaped literal), sort `due` | `open_tasks` | `overdue_tasks` with a stable (name, id) tie-breaker; counts for the page (or all matches when sorting by counts); `complete: false` when the visible-project cap was hit.
- `list_project_members`: owner once, project roles from the project data (never RBAC), deactivated/blocked people omitted, 50 shown, `total`/`truncated`/`complete` honest (examines at most 300 roster entries). Contact details are never selected.
- `list_project_tasks`: status (default open; or a status / all), due (Step 3 semantics), assignee `me` | `any`, limit <= 20; every returned row is re-checked with `canAiViewTask`.
- `get_team`: no argument = list of visible teams WITHOUT members; with `team` = detail with active member names (<= 50). Admin/HR see all teams; everyone else only teams they lead or belong to (a manager with no team sees none). Deactivated/blocked people are neither named nor counted.
- Audit: only enum arguments (`status, overdue, sort, due, assignee, limit`); project / team / name text is never stored (only the argument KEY name).

### Phase 8 Step 5: `get_workload_summary` (eight tools in all)

One new tool, `scope` = `me` (default) | `my_team` | `organization`; no ids, filters, pipelines or roles are accepted. Result: a flat, fixed set of integers (`totalTasks, todoTasks, inProgressTasks, inReviewTasks, completedTasks, cancelledTasks, openTasks, overdueTasks, dueToday, noDueDate`), plus `outcome` (`ok` | `not_available`), `reason`, `scope`, `asOf`, `peopleInScope`, `complete`, `basis`. Unavailable metrics are `null`, never 0.

- **Why analytics is not reused for numbers:** `computeTasks` counts PRIVATE tasks for admins, and `byAssignee` / `computeTeams` / `computePeople` return per-person names and counts (also for HR). Here every figure is ONE `$group` over `buildAiTaskFilter` (the same filter the row lists use), computed in Node; nothing per person, project or task leaves it. Analytics is reused only for its scope kinds (a test asserts the role mapping agrees with `resolveScope`) and for the open-status / overdue definitions.
- **Role -> scope:** employee `me`; manager `me` + `my_team` (teams they LEAD; never `organization`; no team = `no_team_led`); HR `me` + `organization` (aggregate); admin / org-admin `me` + `organization`, `my_team` only if they lead a team; guest / super-admin nothing. Anything else is a fixed `role_not_permitted`.
- **Counting unit:** tasks, not assignments (a task with two team assignees counts once). `my_team` = tasks assigned to at least one ACTIVE, unblocked person of the led teams (lead included).
- **Small groups:** `my_team` and `organization` need at least 5 ACTIVE people (`MIN_COHORT`), else `group_too_small` with no numbers. Blocked and deactivated people do not count.
- **Dates:** overdue = open and due before today in the user's timezone (Step 3 rule); a task due today is `dueToday`, not overdue; `noDueDate` = open without a due date.
- **Audit:** only the `scope` enum.
- **Limitation:** AI visibility applies, so an HR organization total only contains tasks HR is attached to or that are Public in projects HR belongs to; it is deliberately smaller than the analytics figure. An administrator total never includes private projects/tasks they are not attached to.

### Phase 8 Step 6: Python tool orchestration and the trusted authorization signal (dormant)

Node side (minimal): `signGenerateToken({liveTools})` adds `lt: true`; `client.chat` sends `X-Syncos-Tool-Token` (scope `tool:execute`, same request id) ONLY when the pipeline passes `liveTools: true`, which it does only after `openBudget` succeeded (`options.toolBudget`). Retrieval never gets it and `toolBudget` + `rag` is refused. No production caller sets `toolBudget`, so nothing is live. Python side and the full rules: `docs/ai/ai-service-contract.md` §8a. Tool contract file: `ai/app/tools/contract.json` (regenerate with `node scripts/export-ai-tool-contract.js`). Tests: `integration/ai-live-tools-authorization`; Python `test_tools_{definitions,client,auth,loop}`.

### Phase 8 Step 6A: live verification and reliability audit

- **Usage trace:** tokens are summed by Python (one `usage` frame, also before an `error` frame); Node reserves up front (now including the tool definitions Python adds), settles once (the Redis script deletes the reservation, so a second settle is a no-op) and records one event. FIXED: a tool-enabled request cancelled / failed without a usage frame after a tool ran used to settle at 0; it is now charged an estimate. Remaining limits: a cancel before the first tool callback charges 0; multi-round estimates count one round.
- **Config:** Node's tool limits ride in the signed token (claim `tl`); Python can only tighten them; inconsistent limits fail closed on both sides.
- **Real Python <-> real Node** (isolated DB/Redis, fake Groq): `integration/ai-live-tools-cross-process`. Accounting: `integration/ai-tool-usage-accounting`. Still dormant: only tests set `toolBudget`.

### Phase 8 Step 7A: the `tool_activity` event (backend only)

Contract and timer rules: `docs/ai/ai-service-contract.md` §8a. Python emits `{type:'tool_activity', tool}` per validated call right before its callback; `client.js` `toEvent` accepts exactly that shape and the eight names (`AI_LIVE_TOOL_NAMES`, pinned to the registry by a test) else a protocol error; `ai.controller.js` `forUser` rebuilds `{type, tool}` for browsers. The idle timer is armed only AFTER a frame validated, the total ceiling timer is never re-armed. Nothing sends a tool budget in production, so no browser receives this yet. Tests: `integration/ai-tool-activity`, Python `test_tools_activity`, shared wire fixture `frames.json`.

### Phase 8 Steps 8A + 9 (production-readiness engineering; still NOT activated)

- **8A usage:** cumulative snapshots, latest-valid-wins, validated and monotonic (`aiPipeline.acceptUsage`); see ai-service-contract.md §8a. Cancel before the first callback now charges the snapshot that reached Node (it used to be 0); the multi-round estimate under-count is gone whenever a snapshot arrived. Residual: Python dying before it sent a snapshot.
- **Keepalive:** Python sends `: keepalive` while a model call is in flight; Node counts exactly that as proof of life (idle/first-frame), never against the absolute ceiling. This also removes a latent 35 s-idle failure for slow buffered answers.
- **9A hybrid:** `ask.service.streamAnswer` picks `rag` (default), `hybrid` or `tools` on the server, see ai-service-contract.md §8b. The pipeline no longer refuses a tool budget together with `rag`.
- **9B guard:** a tool budget opens only after `assertLiveDataAvailable` (fresh user, USE_AI, AI + live data, platform switches) in the pipeline, before any slot/reservation/budget exists; `liveToolsEligibility` decides what a conversation may offer. Deploy-time activation = `AI_LIVE_TOOLS_ENABLED` (default OFF).
- **9C emergency switch:** `AiPlatformControl` (one row), super-admin `GET/PUT /api/v1/ai/platform/control` (`aiDisabled`, `liveToolsDisabled`, fixed reason code), audited as `ai.platform_control_changed`; read fresh on every gate and every tool callback and after a tool finishes; an unreadable row means OFF (fail closed). Distinct from the organization settings, which stay in force. Python treats the platform refusal as fatal.
- **9D:** a user cancel before the first frame keeps the message and saves an incomplete reply; only a refusal (nothing accepted) rolls back.
- **9E:** HTTP errors never include a stack; diagnostics go to the server log (method + path + code + stack, 5xx only).

## Tests

- Python: `cd ai && .venv/bin/python -m pytest -q` (API surface, security and replay protection, wire contract, chunker). No network, no key.
- Shared fixtures `ai/contracts/*.json` pin the wire format between Node and Python.
- `backend/tests/setup-env.js` points `AI_SERVICE_URL` at a dead port and blanks the signing key, so no test can reach a real service or provider.

## Not verified

Real Groq behaviour (streamed usage location, tool-call chunk shape, error bodies); the Dockerfile (Docker not installed where it was written); Node 20 compatibility (developed on 24.9); behaviour behind a TLS-terminating proxy between Node and Python.

## Not built

Write proposals (the assistant never changes data) and a broader evaluation suite.
