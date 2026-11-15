# Sync OS AI — operations, configuration and limits

Status: implemented and verified, **not deployed and not activated**. Live organizational tools are OFF by default (`AI_LIVE_TOOLS_ENABLED=false`).
Detail lives elsewhere: design and phases in [`ai-overview.md`](ai-overview.md), the wire protocol in [`ai-service-contract.md`](ai-service-contract.md), the Python service in [`../../ai/README.md`](../../ai/README.md).

## 1. Architecture in one page

```
Browser ── Next.js ──► Node API (authority) ──► Python AI service ──► Groq
                         │  ▲                       │
                         │  └── callbacks (loopback listener, signed tokens) ──┘
                         ▼
                 MongoDB · Redis          Python also talks to: Qdrant (vectors), Redis (replay protection)
```

| Owner | Responsibilities |
|---|---|
| **Node** | Authentication, tenant isolation, RBAC, AI settings and disclosure, quotas, rate limits, usage and pricing, audit, document and live-resource authorization, tool execution, the emergency switch |
| **Python** | Groq calls (the only holder of `GROQ_API_KEY`), retrieval and embeddings (the only holder of Qdrant credentials), the tool-calling loop, SSE framing. **No RBAC, no database, no document storage.** |
| **Browser** | Talks only to Node. Shows fixed, friendly activity labels; never sees tool arguments, results, ids or tokens. |

Three answer modes (decided by Node on every request, never by the client): **rag** (documents only, the default), **hybrid** (documents + live tools, two separate data channels and two separate tokens), **tools** (live tools only, when no document index exists). Live tools are offered only when *all* of these hold, each read fresh: the deploy-time flag `AI_LIVE_TOOLS_ENABLED`, the user's identity and `USE_AI`, the organization's `enabled` + `liveDataEnabled`, and both platform emergency switches. Otherwise the request stays a plain document answer.

The eight tools (read-only, fixed, schemas owned by Node): `list_my_tasks`, `list_my_schedule`, `list_projects`, `get_project_overview`, `list_project_members`, `list_project_tasks`, `get_team`, `get_workload_summary`. Python's definitions come from `ai/app/tools/contract.json`, generated from Node's registry with `node backend/scripts/export-ai-tool-contract.js` (both test suites compare against it).

## 2. Setup (development)

1. Services: MongoDB, Redis. For documents: a Qdrant server and the embedding model (see `ai-overview.md`).
2. Keys: `node backend/scripts/generate-ai-keys.js` writes `ai/keys/` (gitignored) and prints the lines for both env files.
3. Node `backend/.env`: `AI_SERVICE_URL`, `AI_SERVICE_SIGNING_KEY` (or `_FILE`), `AI_SERVICE_KEY_ID`. Node never holds Groq or Qdrant settings.
4. Python `ai/.env` (gitignored; copy `ai/.env.example`): `GROQ_API_KEY`, `AI_JWT_PUBLIC_KEY_FILE`, `AI_NODE_INTERNAL_URL`, Redis settings.
5. Start Python: `cd ai && .venv/bin/uvicorn app.main:build --factory --port 8001`; start Node as usual (it also opens the loopback callback listener on `127.0.0.1:5002`).
6. A super-admin or org admin enables AI for the organization (disclosure), then live data (separate disclosure). Nothing is live for anyone until step 7 of §5.

## 3. Configuration reference

### Node (`backend/.env`; defaults in `src/config/env.js`)
| Variable | Default | Meaning |
|---|---|---|
| `AI_GLOBAL_ENABLED` | `true` | Startup kill switch (needs a restart). The *runtime* emergency switch is §4. |
| `AI_LIVE_TOOLS_ENABLED` | **`false`** | Deploy-time activation of live tools for conversations. Keep off until a deliberate rollout. |
| `AI_SERVICE_URL` | `http://127.0.0.1:8001` | Python service (private network only). |
| `AI_SERVICE_SIGNING_KEY` / `_FILE`, `AI_SERVICE_KEY_ID` | — | ES256 private key that signs generate and callback tokens. |
| `AI_INTERNAL_HOST` / `AI_INTERNAL_PORT` | `127.0.0.1` / `5002` | Callback listener. Never expose publicly. |
| `AI_REQUEST_CEILING_MS` | `120000` | Absolute limit of one request. Nothing below can extend it. |
| `AI_SERVICE_CONNECT_TIMEOUT_MS` / `_FIRST_FRAME_` / `_IDLE_` | `5000` / `30000` / `35000` | Transport timers on the Python hop. A valid frame or the exact `: keepalive` line resets idle (and satisfies first-frame); neither touches the ceiling. |
| `AI_RATE_LIMIT_PER_MINUTE`, `AI_MAX_CONCURRENT_PER_USER` | `20`, `3` | Per user. |
| `AI_MAX_OUTPUT_TOKENS` | `2048` | Output cap per model call. |
| `AI_RESERVATION_TTL_SECONDS` | `900` | Must exceed the longest request. |
| `AI_TOOL_MAX_ROUNDS` / `_MAX_CALLS` / `_MAX_CONCURRENT` | `3` / `5` / `2` | Per request. **Node is authoritative**: these ride in the signed token (`tl`) and Python can only be stricter. |
| `AI_TOOL_TIMEOUT_MS` / `_TOTAL_MS` | `8000` / `20000` | One call / all calls of a request. `TOTAL + 10 s` must fit inside the ceiling. |
| `AI_TOOL_MAX_RESULT_BYTES` / `_RECORDS` / `_STRING_CHARS` / `_DEPTH` | `6144` / `50` / `200` / `4` | Size limits on a projected tool result. |
| `AI_PRICING_JSON`, `AI_USAGE_RETENTION_DAYS` | built-in / `395` | Node owns pricing and usage records. |
| `AI_RAG_*`, `AI_CONVERSATION_*`, `AI_INGEST_*`, `AI_EMBEDDING_*` | see `env.js` | Documents, conversations, ingestion, embeddings. |

If live tools are activated and the `AI_TOOL_*` / ceiling values are inconsistent, **the server refuses to start**; if they become inconsistent later, tool requests fail closed.

### Python (`ai/.env`; see `ai/.env.example`)
`GROQ_API_KEY`, `GROQ_BASE_URL`, `AI_MODEL_CHAT` (default `openai/gpt-oss-120b`), `AI_REQUEST_TIMEOUT_MS`, `AI_FIRST_BYTE_TIMEOUT_MS`, `AI_STREAM_IDLE_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_MAX_OUTPUT_TOKENS`; `AI_JWT_PUBLIC_KEY(_FILE|S)`, `AI_JWT_KEY_ID`; `AI_REPLAY_STORE` (+ `REDIS_URL`, `AI_REDIS_PREFIX`); `AI_NODE_INTERNAL_URL`; tools: `AI_TOOL_MAX_ROUNDS|CALLS|CONCURRENT`, `AI_TOOL_TIMEOUT_MS`, `AI_TOOL_TOTAL_MS`, `AI_TOOL_MAX_RESULT_BYTES`, `AI_TOOL_KEEPALIVE_MS` (default `10000`, range 100–20000); retrieval `AI_RAG_*`, embeddings `AI_EMBEDDING_*`, Qdrant `QDRANT_*`. Invalid or inconsistent values stop the process at startup. Python's own tool limits are only ever *tightened* by Node's, never loosened.

## 4. Permissions

| Role | Permissions |
|---|---|
| org-admin, admin | `USE_AI`, `VIEW_AI_USAGE`, `MANAGE_AI_KNOWLEDGE`, `MANAGE_AI`, `VIEW_OWN_ANALYTICS` |
| manager, employee | `USE_AI`, `VIEW_OWN_ANALYTICS` |
| hr | `USE_AI` (organization workload as aggregate counts only) |
| guest, super-admin | none (no tenant AI). Super-admin alone may use the platform control and embedding-platform endpoints. |

Tool visibility is a separate, stricter rule set (`utils/aiAccess.js`): private projects and tasks are never exposed through AI to anyone who is not attached to them, administrators included; a forbidden or missing resource looks identical; HR sees aggregates only; a manager sees only the teams they lead; groups under 5 people are not summarised.

## 5. Operational controls and runbook

Three independent layers, all enforced by Node:

1. **Deploy-time activation** — `AI_LIVE_TOOLS_ENABLED` (restart to change; default off).
2. **Organization settings** — `enabled` and `liveDataEnabled` (admins; each with its own disclosure).
3. **Runtime emergency switch** — super-admin only, takes effect on the very next request and the very next tool callback, no restart:
   ```
   PUT /api/v1/ai/platform/control   {"liveToolsDisabled": true, "reason": "incident"}   # stop live tools, keep plain chat and documents
   PUT /api/v1/ai/platform/control   {"aiDisabled": true,        "reason": "security"}   # stop ALL AI
   PUT /api/v1/ai/platform/control   {"liveToolsDisabled": false, "aiDisabled": false}   # restore
   GET /api/v1/ai/platform/control
   ```
   `reason` is a fixed code (`incident|maintenance|security|other`). Each change is audited (`ai.platform_control_changed`: flags and reason only). It is read fresh on every gate and callback, an in-flight tool that finishes after the flip returns nothing, and **if the setting cannot be read, AI and live tools are treated as OFF**.

**Rollout checklist (when a deliberate decision is made):** rehearse the kill switch and a rollback first; set `AI_LIVE_TOOLS_ENABLED=true` for one pilot environment; enable AI and live data for one pilot organization; watch `ai.tool_invoked` audit rows, usage events (`status`, `toolCalls`, `toolFailures`, `tokensEstimated`) and Python/Node logs (counts and codes only, never content); widen only after a quiet period. **Rollback:** emergency switch first (instant), then the flag.

**What to watch:** usage events with `tokensEstimated: true` (a snapshot was lost), `AI_SERVICE_TIMEOUT`, `AI_PROVIDER_TOOL_ERROR`, spikes in `refused` tool audits, quota denials.

## 6. Known limitations (honest status)

Verified with the real provider (`openai/gpt-oss-120b`, hand-run, throttled): plain answer, one tool, sequential rounds, three tools in sequence, missing resource, HR aggregates, prompt injection in names/titles, cancellation after two tool rounds (real, non-estimated usage recorded).

- **Several tool calls in ONE provider response** — not observed with the real model (it returned one call per round even when asked for several together). Verified with scripted responses only (validation, ordering, the 2-concurrent and 5-call limits, duplicates, cancellation, partial failure). The code supports it; treat live behaviour as unverified.
- **Provider failure after several completed rounds** — verified with scripted failures only (the latest cumulative usage snapshot survives, no tool runs twice). Not forced against the real provider.
- **Groq `tool_use_failed`** happens intermittently; it is retried once (only before any output or tool for that call). After the rounds are used the final answer is requested without tools, from a delimited text copy of the results (a real-model failure mode that `tool_choice:"none"` did not fix).
- **Usage accounting:** snapshots are cumulative and Node keeps the latest valid one. If Groq spent tokens but Python died before sending that round's snapshot, those tokens are unaccounted (Node cannot know). Estimates are flagged `tokensEstimated`.
- **Latency:** tool-enabled answers are buffered and appear when generation ends; the browser shows the activity label meanwhile. Typically several seconds, up to the 120 s ceiling.
- **Prompt injection is mitigated, not solved.** Tool and document text is untrusted data in separate channels; Node authorizes every access independently of the model, so a fully compromised model still cannot widen access (tested). The model can still be *misled* into a wrong or unhelpful answer.
- **English only** for retrieval and tools (language policy at the Node boundary). **Read-only**: no write tools, no agents, no external integrations.
- The stale, unreferenced file `backend/src/routes/index 2.js` was removed (approved, no imports or scripts depended on it). The real router is `backend/src/routes/index.js`.
- HTTP errors never contain a stack trace, in any environment; diagnostics go to the server log (method, path, code, stack for 5xx).

## 7. Test map
Python (`cd ai && .venv/bin/python -m pytest -q`): `test_tools_*`, `test_hybrid_answer`, `test_rag_*`, `test_groq_provider`. Node (`cd backend && npm test`, in-band; use `--forceExit` for the e2e suites): `ai-*`, `conversations-*`, `rag-*`, `http-error-sanitization`; end-to-end with real Python and a scripted Groq: `ai-e2e-{lifecycle,security,reliability}`. Real-Groq and real-browser runs are hand-run scripts under `backend/tests/e2e/` (`e2eServer.js`, `driveLive.mjs`, `driveBrowser.mjs`) against an isolated database and Redis prefix.
