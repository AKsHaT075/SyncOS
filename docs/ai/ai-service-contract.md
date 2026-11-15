# Node ⇄ Python internal contract (v1)

Status legend: **[Built]** exists and is tested · **[Contract only]** specified here, deliberately not implemented yet.

```
Browser ──► Next.js ──► Node backend (authority) ──► Python AI service ──► Groq
                              ▲                              │
                              └──── callbacks (Python → Node, scoped token) ────┘
```

Only Node talks to Python. Browser and Next.js never receive the Groq key, a Python URL, or any token below.

## 1. Who decides what

| Concern | Authority |
|---|---|
| Authentication, sessions, org isolation, RBAC, `orgBlocked` | **Node** |
| AI on/off per org, disclosure, platform kill switch | **Node** |
| Rate limit, concurrency, user/org quotas, reservation + settlement | **Node** |
| Durable usage events, audit, cost (`pricing.js`) | **Node** |
| Which tools a user may use; validating and running a tool | **Node** |
| Which documents/records a user may see (RAG, later) | **Node** |
| Groq key, model choice, prompts, retries, timeouts, SSE parsing | **Python** |
| Tool-loop and RAG orchestration, extraction, chunking, embeddings (later) | **Python** |

Python holds **no RBAC**. It never decides whether a user may do or see something; it only carries out requests Node
already authorized, and asks Node whenever it needs data or an action.

## 2. Tokens

All tokens are **ES256** JWTs. Node holds the private key; Python holds only the public key, so a compromised Python
process cannot mint user context. Verification is strict:

* `algorithms=["ES256"]` is pinned. `none`, `HS*`, `RS*` and any other `alg` are rejected, as is a header `kid`
  that is not in the verifier's key set.
* `iss`, `aud`, `exp`, `iat`, `nbf`, `jti` are all **required**. `exp - iat` must not exceed the per-token maximum
  below. Leeway is 5 s.
* Audiences are distinct per purpose, so a token minted for one purpose is useless for another.
* Identity claims are minimal: opaque ids only. No name, email, role, permissions, tenant name or content.

| Token | `aud` | Issued by → verified by | Claims (besides iss/aud/iat/nbf/exp/jti) | Max lifetime |
|---|---|---|---|---|
| generate | `syncos-ai:generate` | Node → Python | `sub` user id, `org` org id, `jti` = request key, `mo` max output tokens | 60 s |
| status | `syncos-ai:status` | Node → Python | none | 60 s |
| callback | `syncos-node:callback` | Node → Python (carried) → Node | `sub`, `org`, `rid` request key, `scp` scope list | request ceiling (default 15 min) |

`iss` is `syncos-node` for every token.

**Single use.** A generate token's `jti` is consumed atomically on first use (§6). A second request with the same
`jti` is refused with `409 REPLAYED`.

**Callback token (Phase 8).** Node will hand it to Python with the request; today none is issued. Python presents it back to Node's internal listener. Node verifies the signature, the audience and
the scope, then requires that `rid` is **currently in the in-flight set** (the same Redis set that backs concurrency
limiting). When the request finishes, the entry is released and the token is dead, whatever its `exp`.

## 3. Python HTTP surface

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness only: `{"status":"ok"}`. No version, no config. |
| `GET /internal/v1/status` | status token | readiness: `{configured, models{purpose→model}, provider, version, replayStore}`. No secrets. |
| `POST /internal/v1/generate` | generate token (`Authorization: Bearer`) | streaming generation (§4). |

The service binds to `127.0.0.1` by default. In production it must sit on a private network with no public route.
`/docs`, `/redoc` and `/openapi.json` are disabled.

## 4. `POST /internal/v1/generate`

Request headers: `Authorization: Bearer <generate token>`, `Content-Type: application/json`. A **live-tools** request (Phase 8
Step 6) additionally carries `X-Syncos-Tool-Token` (see §8a); every other request carries no callback token on this path.

Body (strict: unknown fields → `422`; **identity fields are not part of the schema**):

```json
{
  "purpose": "chat | summarize",
  "messages": [{"role": "system|user|assistant|tool", "content": "...", "toolCalls": [...], "toolCallId": "...", "name": "..."}],
  "tools": [{"name": "...", "description": "...", "parameters": {}}],
  "toolChoice": "auto | none | required",
  "temperature": 0.2
}
```

Output-token cap comes from the signed token (`mo`), not the body, so it cannot be raised by a tampered body.
Python may lower it further from its own `AI_MAX_OUTPUT_TOKENS`; it can never raise it.

Failures **before** streaming starts are plain JSON with a status code:

| Status | `error.code` | Meaning |
|---|---|---|
| 401 | `TOKEN_INVALID` | bad/expired/wrong-audience/wrong-alg token |
| 409 | `REPLAYED` | `jti` already consumed |
| 413 | `BODY_TOO_LARGE` | over the body limit |
| 422 | `BAD_REQUEST` | schema violation |
| 503 | `NOT_CONFIGURED` | Groq key missing |
| 503 | `REPLAY_STORE_UNAVAILABLE` | cannot prove single use → refuse (fail closed) |

Otherwise `200 text/event-stream`. Each frame is `event: <type>\ndata: <json>\n\n`; the JSON carries `type` too.
`: ping` comment lines are keepalives and carry no meaning; Node ignores them. **Python v1 does not send any** (the first-frame and idle timers make them unnecessary on a direct internal link).

| Frame `type` | Payload | Notes |
|---|---|---|
| `text` | `{text}` | zero or more |
| `tool_calls` | `{calls:[{id,name,arguments,input,inputError}]}` | at most once, after the text |
| `tool_activity` | `{tool}` (exactly two fields with `type`) | **Live-tools requests only** (§8a). Zero or more, before the answer. `tool` is one of the eight tool names. Progress only: not output, not usage |
| `usage` | `{inputTokens,outputTokens,totalTokens,estimated}` | plain / document answers: at most once. LIVE-TOOLS requests (§8a): a CUMULATIVE snapshot after every completed model round that leads to tool calls, and a final one before `done`. Node keeps the LATEST valid snapshot and never adds them. `estimated:true` = Python's chars/4 guess |
| `done` | `{finishReason,model,provider,requestId,firstEventMs}` | **terminal, success** |
| `error` | `{code,retryable,streamStarted,upstreamStatus}` | **terminal, failure**. No message text, ever |

Rules:

1. **A stream is complete only if its last frame is `done` or `error`.** A body that ends without one is a truncated
   stream and Node treats it as `AI_PROVIDER_UNAVAILABLE` with `streamStarted` set from what it saw.
2. `usage` precedes `done`. Python reports **tokens and model only**; Node computes cost.
3. Nothing is retried after the first `text`/`tool_calls` frame. `error.streamStarted` says whether that happened.
4. Error `code` is one of the normalized provider codes in `ai.constants.js` (`AI_PROVIDER_*`, `AI_CONTEXT_TOO_LONG`,
   `AI_CONTENT_FILTERED`, `AI_NOT_CONFIGURED`, `AI_REQUEST_ABORTED`, `AI_PROVIDER_INVALID_RESPONSE`). Node adds
   `AI_SERVICE_UNAVAILABLE`, `AI_SERVICE_TIMEOUT`, `AI_SERVICE_AUTH`, `AI_SERVICE_PROTOCOL` for failures of the hop
   itself.
5. Prompts, completions, document text, tokens and keys are never logged by either side.

## 5. Cancellation

```
browser closes → Express res 'close' → AbortController → fetch to Python aborted
   → Starlette cancels the response generator → httpx closes the Groq stream
```

Python checks `request.is_disconnected()` between frames and cancels the upstream call. Node's request-key release,
settlement and usage recording run in `finally` and do not depend on Python noticing.

## 6. Replay protection

`ReplayGuard.consume(jti, ttl)` must be atomic and return `False` for any `jti` seen before within its lifetime.

* **Production (default): Redis.** `SET <prefix>:jti:<jti> 1 NX EX <ttl>`; `OK` ⇒ first use. Works across any number
  of Python replicas. If Redis is unreachable the request is refused (`503 REPLAY_STORE_UNAVAILABLE`), never allowed.
* **Single-instance in-memory:** only when `AI_REPLAY_STORE=memory` **and** `AI_SINGLE_INSTANCE=true`. Both must be
  set; `memory` alone refuses to start. Running more than one replica with this store is unsupported and unsafe. The
  status route reports `replayStore` so an operator can see which one is in use.

## 7. Exactly-once quota settlement

Settlement is **Node-only**. Python never reads or writes quota counters.

* One Node request ⇒ one `requestKey` ⇒ one reservation ⇒ one settlement (the settle script deletes the reservation
  record atomically, so a second settle for the same key is a no-op).
* Groq retries inside Python are invisible to Node and are not charged twice: only the final `usage` frame counts.
* Node never re-sends a generate request on its own after any frame arrived, and never reuses a `jti`.
* Charge by outcome (unchanged from Phase 2): real `usage` wins; `done` without usage ⇒ estimate; error/cancel before
  output ⇒ 0; error/cancel/truncation after output ⇒ estimate of input + output so far.
* Known limit: if Python spent Groq tokens but the hop failed before any frame reached Node, Node charges 0. The loss
  is bounded by one request's reservation and is reported in `docs/ai/ai-overview.md`.

## 8. Callbacks into Node **[Built: the authorization gate and internal listener · Not built: any real tool, and Python never calls it yet]**

Internal listener (`AI_INTERNAL_HOST:AI_INTERNAL_PORT`, default `127.0.0.1:5002`; never mounted on the public port;
its own error handler, so no stack traces or unexpected error text ever leave it):

`POST /internal/ai/tools/execute` with `Authorization: Bearer <callback token>`, body `{callId, name, arguments}`.

For **every** call Node independently: verifies the token (§2); requires `rid` in the in-flight set; loads the user
fresh from the database (blocked/removed/role change takes effect immediately); looks the tool up in **Node's own**
registry; checks that user's permission for that tool; validates `arguments` with Node's own schema; then calls the
existing service as that user. The tool list Node sent to Python is a convenience for the model and is **never** an
authorization boundary: a name Python invents, or a tool the user may not use, returns `404 TOOL_NOT_FOUND` exactly as
an unknown tool would. Write-capable tools return proposals only; execution needs the separate user confirmation
endpoint.

## 8a. Live tools: authorization and orchestration (Phase 8 Step 6) **[Built; dormant: no production caller opens a tool budget yet]**

**The trusted signal.** Python may orchestrate tools for a generate request only if BOTH hold:

1. the verified generate JWT carries `lt: true` (Node sets it only after it opened a Redis tool budget for this request; absent otherwise;
   any other value, including `false`, is refused with `401 TOKEN_INVALID`) AND `tl`, Node's tool limits for this request
   (`{r rounds, c calls, k concurrent, t per-call ms, m total tool ms, b result bytes, d request ceiling ms}`; all integers within sane bounds
   and mutually consistent, else `401`; `tl` without `lt`, or `lt` without `tl`, is refused). Python's effective limits are the STRICTER of
   `tl` and its own `AI_TOOL_*`; it can never exceed Node's, and its deadline is `min(own, d - 10 s)`. Limits that leave no room to work
   (e.g. a ceiling too short for one call) are `503 TOOLS_MISCONFIGURED`, not a run with less safety. Node refuses to mint `tl` for an inconsistent
   configuration (more in flight than calls, tool time not fitting inside the ceiling), so such a request never starts; Python refuses to start
   with inconsistent `AI_TOOL_*`. And
2. `X-Syncos-Tool-Token` holds a callback token that Python checks: ES256 with our key ids, audience `syncos-node:callback`, scope list
   exactly `["tool:execute"]` (a `knowledge:authorize` token, or one with extra purposes, is refused), `rid` = this request's jti, `sub`
   and `org` = the generate token's, lifetime <= 600 s.

Either half missing or mismatched = `401` with no Groq call and no callback. A tool header without `lt` is ignored (plain generate). A document answer (`/internal/v1/answer`) MAY also carry `lt` + `X-Syncos-Tool-Token` (Step 9A, below); without both it is document-only and offers no tools. Nothing in the request BODY (strict schema) or in model output can enable it.
In this mode Python offers its own fixed eight definitions and ignores `body.tools` / `toolChoice`.

**Tool definitions.** `ai/app/tools/contract.json` is generated from Node's registry (`node backend/scripts/export-ai-tool-contract.js`)
and read by Python at import (strictly: exactly the eight names, closed schemas, only supported JSON-Schema keywords). Node's test compares it
to the live registry; Python's test pins every property/required/enum by hand. Node's Zod schemas stay authoritative.

**Loop.** At most 3 rounds in which the model may ask for tools, then one more call WITHOUT tools writes the answer. At most 5 calls per
request (every call the model makes counts, valid or not), 2 in flight, 8 s (+1.5 s grace) per call, 20 s summed tool time, 110 s for the whole
request. Calls are validated before anything is sent (name, id, JSON-object arguments <= 1024 chars, closed schema, no repeat of tool+arguments);
a refused call still gets a short error tool message so every call id is answered. A duplicate/malformed call id, an empty answer, or a tool call
when none were offered is a terminal `AI_PROVIDER_INVALID_RESPONSE`; Groq failing to generate a tool call (`tool_use_failed`, seen live) is retried ONCE per request (nothing ran, nothing was streamed), then final; a 401/403 from Node (token, request, user, AI or live data gone) is a terminal
`AI_PROVIDER_TOOL_ERROR`. Callbacks are never retried. Results are validated (plain JSON object, bounded size/depth/strings, no forbidden keys),
defanged (`<`/`>` and our delimiters neutralized) and passed to the model as `{"status":"ok","result":…}` or `{"status":"error","error":CODE}`;
the system rules tell the model they are untrusted data.

**Usage.** Python sums every round's usage into one `usage` frame (also sent before an `error` frame when earlier rounds spent tokens). If a tool-enabled request ends WITHOUT a usage frame (browser closed, usage hop lost) but a tool had run, Node charges an ESTIMATE (input estimate incl. the tool definitions, flagged `tokensEstimated`) instead of zero. A cancel before any tool ran still settles at zero, as for any request. Settlement is Node-only and idempotent.

**On the wire.** The frames are: `tool_activity` (below), then only the final answer's `text`, one summed `usage`, and `done` (or `error`, preceded
by a `usage` frame when earlier rounds spent tokens). `tool_calls` frames are never emitted in this mode, and text written alongside a tool call
is dropped.

**Cumulative usage (Step 8A).** In live-tools mode `usage` frames are SNAPSHOTS: each carries the total of everything Groq has reported so far in this request (e.g. 1,000 -> 2,400 -> 4,180), sent as soon as a round completed and BEFORE its tools run. Node stores the latest valid one (settlement figure = the last, 4,180, not the sum, 7,580); it ignores a snapshot that is malformed (non-integer / negative / > 50M / total below its parts) or goes backwards in input, output or total; repeats are harmless. Per round, tokens are Groq's reported prompt (which already contains the tool definitions, and any cached tokens, billed as prompt) plus completion; Python adds the rounds, never the snapshots. A round that never completed (a failed generation, a 5xx) reports nothing and is never invented. The retried `tool_use_failed` generation reports no usage and is not counted. Residual case: if Groq consumed tokens but Python died before sending that round's snapshot, those tokens are unaccounted (Node cannot know). Node forwards only ONE final usage event to the browser, right before `done`.

**Keepalive.** A tool-enabled answer is buffered, so while a model call is in flight Python sends the SSE comment line `: keepalive` about every `AI_TOOL_KEEPALIVE_MS` (default 10 s). Node counts exactly that line as proof of life: it satisfies the first-frame timer and resets the idle timer, and nothing else does (any other comment is ignored). It NEVER touches the absolute request ceiling, and Python's own deadline caps how long it can keep sending.

**`tool_activity`** `{"type":"tool_activity","tool":"<name>"}` (Step 7A). Emitted for a call that has PASSED validation (name, id, arguments, schema, not a repeat, within budget), immediately before its Node callback: Python waits until the frame has been handed to the consumer before the callback starts. Never for refused, invalid, unknown, duplicate or over-budget calls; never any argument, id, result or token. Node's client accepts it only with exactly those two fields and a name from `AI_LIVE_TOOL_NAMES` (anything else is `AI_SERVICE_PROTOCOL`); Node's browser filter rebuilds it as exactly `{type, tool}`. Timers: a VALID `tool_activity` satisfies the first-frame timeout and resets the idle timeout (a tool-enabled request is otherwise silent until its answer); a frame that fails validation resets nothing (it ends the stream), and the absolute request deadline (`AI_REQUEST_CEILING_MS`) is never extended. It does not set `streamStarted` and adds nothing to usage. Consequence: a tool-enabled answer is delivered when its generation ends, not token by token.

## 8b. Hybrid: documents + live tools (Step 9A)
`/internal/v1/answer` with `lt`/`tl` in the generate token AND a valid tool token (plus the usual knowledge token) retrieves first, then runs the tool loop with the document sources in a delimited block of the USER message (`HYBRID_SYSTEM_PROMPT`; tool rules are appended to the system message) and tool results as TOOL messages. Channels never mix; each is authorized by Node on its own token and scope; Python verifies both signals independently. With no matching documents the tools still run (`(no document matched this question)`), and the answer is uncited; the fixed "not in your documents" reply belongs to document-only answers. `citations` are validated exactly as before (Node re-checks them against the chunks it released); the frame order is text, usage, citations, done. The follow-up rewrite call's spend seeds the cumulative usage. Node chooses the mode (§ ask.service): hybrid when live tools are eligible and retrieval is available, tools-only when eligible but no index/retrieval, otherwise document-only.

## 9. Environment

Python: `AI_JWT_PUBLIC_KEYS`/`_FILE`, `GROQ_API_KEY`, `GROQ_BASE_URL`, `AI_MODEL_CHAT`, `AI_MODEL_SUMMARIZE`,
`AI_REQUEST_TIMEOUT_MS`, `AI_FIRST_BYTE_TIMEOUT_MS`, `AI_STREAM_IDLE_TIMEOUT_MS`, `AI_MAX_RETRIES`,
`AI_MAX_OUTPUT_TOKENS`, `AI_NODE_INTERNAL_URL` (tool/knowledge callbacks), `AI_TOOL_KEEPALIVE_MS`, `AI_TOOL_MAX_ROUNDS`/`_MAX_CALLS`/`_MAX_CONCURRENT`/`_TIMEOUT_MS`/`_TOTAL_MS`/`_MAX_RESULT_BYTES` (Python defaults equal Node's), `AI_REPLAY_STORE`, `AI_SINGLE_INSTANCE`, `REDIS_URL`, `AI_REDIS_PREFIX`, `HOST`, `PORT`.
Node: `AI_SERVICE_URL`, `AI_SERVICE_SIGNING_KEY`/`_FILE`, `AI_SERVICE_KEY_ID`, `AI_SERVICE_TIMEOUT_MS`,
`AI_REQUEST_CEILING_MS`, plus the existing limit/quota/usage variables. Node no longer holds `GROQ_*`.

## 10. Fixtures

`frames.json` (wire ⇄ normalized events) and `error_mapping.json` (upstream HTTP failure ⇄ normalized code) are read by
**both** the Jest and pytest suites. Changing either side's behaviour without updating the fixture fails one suite.

## 11. Document ingestion (Phase 3) — worker ⇄ Node **[Built]**

A **separate Python process** (`python -m app.ingestion.worker`) extracts and chunks documents. It is a *pull* worker:
it has **no database, no storage access and no Groq key**; every byte it sees and every fact it records goes through
Node's internal listener (`127.0.0.1:5002`, `/internal/ingestion/*`).

**Credential (opposite direction to §2).** The worker signs ES256 tokens (`iss=syncos-ai-worker`,
`aud=syncos-node:ingestion`, `sub`=worker id, 30 s, `kid`); Node verifies with the worker's **public** key
(`AI_WORKER_PUBLIC_KEY[_FILE]`). It is a different key pair from §2, so neither key works in the other direction.
Each token's `jti` is consumed atomically in Redis on the Node side (single use; Redis down ⇒ `503`). The token only
proves "our worker": no endpoint grants anything without a **claimed job + its lock token**.

| Route | Purpose |
|---|---|
| `POST /claim {pipelineVersion}` | atomically claim the next runnable job → `{job:{id,format,size,sha256,lockToken,leaseSeconds,attempt,pipelineVersion}}` or `{job:null}`. The recorded worker id is the **authenticated** `sub`, never the body. |
| `POST /jobs/:id/heartbeat {lockToken}` | extend the lease (bounded by a hard processing cap). `409` ⇒ stop. |
| `GET /jobs/:id/content` + `X-Lock-Token` | stream the claimed version's bytes. |
| `POST /jobs/:id/result {lockToken,result}` | submit `indexed` (chunks) / `skipped` (reason) / `failed` (reason). |

**Content access** is refused (`409`) unless the job is `processing`, the lock token matches and the lease is live, **and**
the live document — looked up by `{_id, organization}` — still exists, is not trashed, and still has the job's version and
checksum. A stale/deleted document marks the job `skipped` (`SUPERSEDED` / `DOCUMENT_DELETED`) instead. A job can never
address another tenant's blob. The worker verifies the sha256 itself (`CHECKSUM_MISMATCH` ⇒ retryable failure).

**Job identity** is `(organization, document, version, pipelineVersion)` — a unique index; enqueue is an upsert, so
duplicates are impossible. Statuses: `queued → processing → indexed | skipped | failed → (backoff) → … → dead`.
Pipeline versions must match (`ai/contracts/ingestion.json`); a worker for another pipeline is handed nothing.

**Outcomes.** `skipped` = permanent content problem with a reason (`UNSUPPORTED_FORMAT FILE_TOO_LARGE ENCRYPTED
NO_EXTRACTABLE_TEXT EMPTY CORRUPT TOO_MUCH_TEXT ARCHIVE_LIMIT`; Node adds `SUPERSEDED DOCUMENT_DELETED`). `failed` =
transient (`EXTRACTION_TIMEOUT EXTRACTION_CRASHED EXTRACTION_OOM CHECKSUM_MISMATCH DOWNLOAD_FAILED INTERNAL_ERROR`,
plus Node's `LOCK_EXPIRED STORAGE_MISSING`), retried with jittered exponential backoff up to `maxAttempts`, then `dead`.
Reasons are codes: no parser or upstream message ever crosses the boundary.

**Result schema (strict; unknown fields ⇒ `400`).** `indexed`: `{format, pipelineVersion, stats, chunks:[{index,text,textHash,tokenEstimate,location}]}`
— indexes contiguous from 0, `textHash` = sha256(text) re-computed by Node, ≤3000 chunks, ≤8000 chars each,
`location` ⊆ `{pageStart,pageEnd,headingPath,sheet,rowStart,rowEnd,slideStart,slideEnd,charStart,charEnd}`. A result that
fails validation fails the job (`INTERNAL_ERROR`, retried, then dead); nothing is stored. Chunks are stored under the
**job's** organization, never one supplied by the worker. Writing is an idempotent upsert per chunk index followed by
deletion of the tail, then a lock-fenced flip to `indexed`; the document is re-checked after the flip and chunks are
rolled back if it was trashed/re-versioned in that instant.

**Fencing.** Only the holder of the current lock token can heartbeat, fail, skip or index. A worker whose lease lapsed and
was re-claimed is rejected (`409`) and cannot overwrite the new owner. Lapsed leases are recovered by Node
(`failed`/`dead`, `LOCK_EXPIRED`).

**What a chunk is.** Text plus `location` — **no access-control data**. Whether a user may see a chunk is decided by Node
from the live `Document` at retrieval time (Phase 5); chunks are trusted only while their job is `indexed` for the
document's current version and pipeline.

## 12. Embeddings and the vector store (Phase 4) — embedding worker ⇄ Node **[Built]**

A second **separate Python process** (`python -m app.embeddings.worker`) turns Node-authorized chunk text into vectors and
writes them to Qdrant. It holds a Qdrant config and the worker key; **no database access, no Groq key**. Node never talks to
Qdrant and holds no Qdrant setting.

**Embedding space** (`ai/contracts/embedding.json`, golden ids tested in both languages). A space is the hash of:
model, exact revision, ONNX file, dimensions, pooling, normalization, query prefix, passage prefix, max tokens, distance,
embedding-pipeline version (`e1`) and ingestion-pipeline version (`p2`). Different hash ⇒ different Qdrant collection
(`<QDRANT_COLLECTION_PREFIX>_<spaceId>`), different jobs. Vectors of different spaces are never mixed or compared. The v1 model is
`intfloat/multilingual-e5-small` @ `614241f6…` (MIT, 384-d, 512-token window, mean pooling, L2-normalized, `query: `/`passage: ` prefixes).

**Credential.** Same worker key pair as §11, audience **`syncos-node:embedding`** (strictly validated; an ingestion token is
refused on these routes and vice versa); 30 s, single-use jti in Redis.

| Route | Purpose |
|---|---|
| `POST /internal/embedding/claim {spaceId, ingestionPipeline}` | atomically claim the next job for the space this worker produces. Purges are handed out before embeds. Returns `{id, kind, organization, document, version, ingestionPipeline, spaceId, keepVersion, generation, chunkCount, lockToken, leaseSeconds, attempt}`. |
| `POST /jobs/:id/heartbeat {lockToken}` | extend the lease; `409` ⇒ stop |
| `GET /jobs/:id/chunks?after&limit` + `X-Lock-Token` | one page of the claimed **embed** job's chunk text (≤100 chunks, ≤600k chars) |
| `POST /jobs/:id/result {lockToken, result}` | `embedded {spaceId, model, revision, dimensions, count, digest}` / `completed {deleted, generation}` (purge) / `failed {reason}` |

**Job kinds.** `embed` — make ONE document version's vectors exist in ONE space (idempotent "sync to desired state": the
worker compares stored text hashes, embeds only new/changed chunks, deletes strays). `purge` — remove a document's vectors from
ONE space, all versions or all but `keepVersion`; re-requesting bumps `generation`, and a result for an older generation does not
complete the newer request. Unique key: (organization, document, kind, version, ingestionPipeline, spaceId).

**What Node checks before accepting `embedded`:** the space id, model, revision and dimensions equal the registered descriptor;
`count` equals the number of chunks Node holds; `digest` = sha256 of the ordered chunk text hashes recomputed from Mongo; and the
live document is still current. Anything else fails the job (`RESULT_MISMATCH`) and is never accepted.

**Chunk text** is served only for a claimed embed job with a live lease, after re-checking that the document exists in THAT
organization, is not trashed, is still the job's version, its extraction job is `indexed`, and AI is still enabled; the chunk
query is organization-scoped. **Vectors never pass through Node.**

**Qdrant layout.** One point per chunk: id = uuid5(org, document, version, ingestionPipeline, chunkIndex) (idempotent upsert,
tenant-specific ids); 384-d cosine vector; payload `{organization, document, version, chunk_index, text_hash, ingestion_pipeline,
space}` and **nothing else — no text, no permissions**. Payload indexes: `organization` (keyword, `is_tenant`), `document`
(keyword), `version` (integer). Payload is for filtering and cleanup, **never an authorization source**: Phase 5 authorizes from the
live `Document` in Node and may pass Python only the document ids Node allowed.

**Validation before any write:** vector length == space dimensions (and == the collection's), finite, unit norm. A mismatch is
refused before anything is sent. Every `VectorStore` method requires an `organization` and adds it to every filter.

**Lifecycle (Node decides, workers execute).** Extraction `indexed` ⇒ embed jobs for every served space. New version embedded ⇒ older
versions' vectors purged. Trash/permanent delete ⇒ purge in every space (embed rows `skipped`, purge row kept until done). Restore ⇒
revived. A version whose successor could not be extracted ⇒ the stale vectors are purged. Orphans (rows whose document is gone) and
periodic **verification** (completed jobs re-queued oldest-first) repair gaps and a damaged index.

**Migration (atomic from the application's view).** `AiEmbeddingConfig` holds `activeSpaceId` (served), `targetSpaceId` (being
built), `retiringSpaceId`. A changed model/pipeline starts a migration: workers fill the target beside the active space (new documents
go to both). `promote()` requires full coverage of eligible documents, no failed/dead/pending jobs, and a spot-check that digests
match the chunks Node holds; it then flips the pointer in one compare-and-swap on `revision`. A failed, stalled or abandoned migration
never touches the active space. The previous space is kept for `AI_EMBEDDING_RETIRE_GRACE_HOURS`, then purged. Promote / abandon /
start are **super-admin** operations (the pointer is platform-wide); tenant admins see and act on their own organization's jobs only.

## 13. Retrieval-augmented answers (Phase 5) — Node ⇄ Python **[Built]**

Flow: `POST /api/v1/ai/ask` (Node: auth, org, AI gate, `USE_AI`, rate/concurrency/quota) → Node signs a generate token (extra optional claim `spc` = active embedding space id) and a callback token (scope `knowledge:authorize`) → `POST /internal/v1/answer` on Python (header `X-Syncos-Callback-Token`; body `{question}` only) → Python embeds the query (`query: ` prefix), searches the active Qdrant collection, then asks Node `POST /internal/ai/knowledge/authorize` (≤50 candidates `{documentId, version, chunkIndex, textHash}`) → Node returns text ONLY for chunks that pass live authorization → Python builds a bounded, numbered context, calls Groq (no tools) and streams frames.

- Frames: `retrieval` (counts only), `text`, `usage`, `citations`, `done` | `error`. No-answer path: fixed message in the question's script (en/hi/pa), NO Groq call, zero usage.
- Qdrant payload is never authorization. Node authorizes from the live Document: org scope, not deleted, `canView`, private = owner only (admins/shares excluded), `currentVersion === candidate.version`, ingestion job `indexed` (current pipeline), embedding job `completed` in the ACTIVE space, chunk exists with equal `textHash`. Failures are dropped silently (only a count).
- Python verifies returned items ⊆ asked and `sha256(text) == textHash`. A model tool call is dropped; no tools are offered.
- Citations: `{n, chunkId, documentId, documentName, version, chunkIndex, location, score}` for sources both retrieved+authorized AND cited by a valid marker. Invalid markers go to `unverifiedMarkers`. Node re-filters against Redis `ai:rag:auth:<requestKey>` (fail closed).
- Errors: `AI_RETRIEVAL_UNAVAILABLE` (store/embedder/authorizer/space mismatch), `AI_KNOWLEDGE_NOT_READY` (503, no active space or retrieval disabled).
- Defaults: top_k 6, candidates 24 (widen 72, 200), min cosine 0.81 (multilingual-e5-small specific; recalibrate after any model change), window 0.05, near-duplicate Jaccard 0.70, 3 per document, 3000 context tokens.

## 14. Conversations (Phase 6) **[Built]**

`POST /internal/v1/answer` accepts an optional `history` (<= 6 turns `{role: user|assistant, content <= 1000}`) chosen and trimmed by Node. Python uses it ONLY to rewrite the question into a standalone one (`rag/condense.py`; one Groq call, `max_retries=0`, deterministic fallback = previous user question + current). The rewrite's usage is added to the `usage` frame (also on the no-answer path), so Node charges it. History is wrapped in `<history>`/`<turn>` delimiters, neutralized, and never placed in the answer prompt. Conversations themselves live only in Node.
