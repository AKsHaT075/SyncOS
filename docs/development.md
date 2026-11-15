# Development guide

Day-to-day working notes for Sync OS. The quick start is in the root [README](../README.md).

## 1. Local environment

| Service | Needed for | Start |
|---|---|---|
| MongoDB 27017 | everything | `brew services start mongodb-community`, or if that fails on an untrusted tap: `mongod --config /opt/homebrew/etc/mongod.conf --fork` (does not survive a reboot) |
| Redis 6379 | auth OTP, notifications, email queue, AI limits | `brew services start redis` |
| LiveKit | joining meeting rooms | `cd backend && npm run livekit:dev` (needs `livekit-server`; config `backend/livekit.dev.yaml`) |
| AI service, workers, Qdrant | AI Studio, document search | see [ai/ai-operations.md](ai/ai-operations.md) and [ai/README](../ai/README.md) |

Start the backend with `cd backend && npm run dev` (nodemon) and the frontend with `cd frontend && npm run dev`. If a leftover server holds port 5001 you will see `EADDRINUSE`; kill the old process before restarting.

## 2. Environment variables

Copy `backend/.env.example` to `backend/.env`, `frontend/.env.example` to `frontend/.env.local`, and `ai/.env.example` to `ai/.env`. All of these are gitignored. Never commit real values and never put the Groq key anywhere except `ai/.env`.

**Backend (`config/env.js` validates once at startup; the app refuses to start without the three required values):**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MONGO_URI` | yes | | MongoDB connection string |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | yes | | token signing |
| `PORT` | no | `5000` (the example file uses `5001`, which the frontend expects) | API port |
| `CLIENT_URL` | no | `http://localhost:3000` | CORS origin and links in emails |
| `REDIS_URL` | no | `redis://127.0.0.1:6379` | Redis |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | no | `15m`, `7d` | token lifetimes |
| `AUTH_*_COOKIE_NAME` | no | `sync_access_token`, `sync_refresh_token`, `sync_csrf_token`, `sync.sid` | cookie names; the CSRF name must match the frontend |
| `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` | no | empty, `587` | email delivery (without it mail is not sent) |
| `STORAGE_DRIVER`, `STORAGE_LOCAL_ROOT`, `UPLOAD_TMP_DIR`, `DOCUMENT_MAX_FILE_SIZE_MB` | no | `local`, `backend/uploads/...`, `25` | document storage |
| `LIVEKIT_URL/API_KEY/API_SECRET`, `LIVEKIT_WEBHOOK_ENABLED` | no | empty, `false` | meetings |
| `NOTIFICATION_RETENTION_DAYS`, `NOTIFICATION_CHANNEL_PREFIX`, `EMAIL_QUEUE_PREFIX` | no | `90`, `notif`, `email` | notifications |
| `AI_TOKENS_PER_CREDIT` | no | unset | tokens one plan AI credit is worth; unset = AI credits not enforced |
| `AI_*` | no | see [ai/ai-operations.md](ai/ai-operations.md) | AI integration; `AI_LIVE_TOOLS_ENABLED` defaults to off |

**Frontend:** `NEXT_PUBLIC_API_URL` (default `http://localhost:5001/api/v1`) and `NEXT_PUBLIC_CSRF_COOKIE_NAME` (default `sync_csrf_token`). A wrong CSRF cookie name makes every POST fail with 403 (a local `backend/.env` may override the cookie names, for example to `synapse_*`; the frontend `.env.local` must use the same names).

## 3. Workflow and conventions

- **JavaScript only** (no TypeScript). Follow the existing pattern of the module you are touching rather than introducing a new system.
- **Backend layers:** routes (middleware chain only) -> controllers (thin, `asyncHandler`) -> services (all logic) -> models. Validate with Zod through `validateBody`/`validateQuery`. Put pure access rules in `utils/*Access.js` so they are unit-testable.
- **Every tenant route** uses `authenticate, requireOrgAccess`, and every query filters by `organization`. Return 404 for both "not found" and "not yours".
- **Adding a permission:** add it to `constants/permissions.js`, grant it in `rolePermissions.js`, mirror it in `frontend/src/constants/permissions.js`, and gate the route with `checkPermission`. Add audit events to `constants/audit.constants.js` and log through `logAudit`.
- **Adding a notification:** add an event in `notificationEvents.js` with a deterministic `occurrence` for the dedupe key. Do not create notifications anywhere else.
- **Dates:** instants are UTC; clients send wall-clock time plus a zone; due dates and all-day items are floating `YYYY-MM-DD` values and must never be shifted.
- **Frontend:** a module is `features/<name>/{components,hooks,services,schemas}`; add a page under `app/dashboard/<name>`; invalidate the module's query key after mutations; use semantic Tailwind tokens; show loading, empty and error states. Do not link to routes that do not exist.
- **API conventions:** `/api/v1/...`, JSON, `{ success: true, ... }` on success, `{ success: false, message, code }` on error; pagination uses `page` and `limit`; list endpoints validate their query with Zod.
- **Errors:** throw `AppError(message, status, CODE)` from services. Do not leak stack traces or internal details in responses.
- **Comments and docs:** explain *why*. Keep module notes in `docs/`.

## 4. Testing approach

- Backend: Jest + Supertest, `cd backend && npm test` (always `--runInBand`). `tests/setup-env.js` gives every test file its own database (`syncos_test_*`) which is dropped afterwards, so your development database is never touched. Uploads in tests go to the OS temp directory. Mock `middlewares/rate-limit.middleware` in large suites because the global limit is 300 requests per 15 minutes.
- Prefer a targeted run while developing, for example `npx jest tests/integration/assets-core.test.js --runInBand`, and one full run before a release. Leftover `syncos_test_*` databases from killed runs slow MongoDB down; drop only those.
- AI service: `cd ai && .venv/bin/python -m pytest -q`. Tests never use a real Groq key.
- Frontend: `cd frontend && npm test` (pure utilities, `node --test`) and `npm run lint`. Do not run `next build` while `next dev` runs from the same folder, it corrupts `.next`; build a copy.
- Coverage today: strong for documents, calendar, notifications, assets, analytics, AI and RBAC predicates; thinner for projects, meetings and the people/teams flows (see [project-status.md](project-status.md)).

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Missing required environment variable` | `backend/.env` lacks `MONGO_URI`, `JWT_SECRET` or `JWT_REFRESH_SECRET` |
| `EADDRINUSE :5001` | an old backend is still running; kill it |
| Every POST returns 403 | CSRF cookie name mismatch between backend and `NEXT_PUBLIC_CSRF_COOKIE_NAME`, or cookies blocked |
| 429 in tests | the global rate limit; mock the rate-limit middleware |
| No emails arrive | SMTP is not configured; check the email queue logs |
| Meeting room will not open | `LIVEKIT_*` unset or LiveKit not running |
| AI Studio says AI is unavailable | AI is off for the organization (admin must accept the disclosure), `AI_GLOBAL_ENABLED` is false, or the Python service is down; see `GET /api/v1/ai/status` |
| Document search returns nothing | retrieval needs a Qdrant server and `AI_RAG_ENABLED=true` in `ai/.env`, and documents must be ingested and embedded |
| Mongo start fails through brew | use the `mongod --config ... --fork` command above |
