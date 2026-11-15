# Deployment preparation

Nothing in this repository has been deployed, and no service is exposed publicly. This document lists what a future deployment must provide and decide. It is a preparation checklist, not an operations runbook. AI-specific rollout, kill switch and rollback steps are in [ai/ai-operations.md](ai/ai-operations.md) and are not repeated here.

## 1. Components to run

| Component | Notes |
|---|---|
| Next.js frontend | `npm run build` then `npm start`, behind HTTPS. `NEXT_PUBLIC_*` values are baked in at build time. |
| Express API | `npm start` (`NODE_ENV=production`). One public port plus a **loopback-only** internal listener (`AI_INTERNAL_HOST/PORT`, default `127.0.0.1:5002`) that must never be exposed. |
| MongoDB | Managed or self-hosted, authentication on, TLS where the network is not private. |
| Redis | Authentication on, private network. |
| LiveKit | Production LiveKit server with its own API key and secret; webhook URL pointing at `/api/v1/livekit/webhook` with `LIVEKIT_WEBHOOK_ENABLED=true`. |
| SMTP | A real provider; without it OTP, invitations and notification emails are not delivered. |
| AI (optional) | Python service, ingestion worker, embedding worker, a Qdrant **server** (the embedded Qdrant used in development is refused in production). Only needed if AI is enabled. |

## 2. Infrastructure assumptions and limits found during the audit

- **Rate limiting is per process.** The HTTP limiters use the in-memory store. Behind several API instances the effective limit is multiplied by the instance count; move the stores to Redis before scaling out.
- **Background timers are not leader-elected.** Meeting cleanup, reminders, asset alerts, the email worker and AI jobs start inside every API process. Duplicate runs are mostly guarded by deterministic dedupe keys and atomic claims, but this has been verified only for a single instance. Run one instance, or verify each job before scaling.
- **Notification live streams** use Redis pub/sub across instances. Each browser holds one SSE connection per tab leader, so size connection limits and proxy timeouts (no buffering, long read timeout) accordingly.
- **File storage is local disk** (`STORAGE_DRIVER=local`). It needs a persistent volume, backups and a single writer. The storage interface has five methods, so an object-store provider can be added later; none exists today.
- **MongoDB is used as a standalone server (no transactions).** Integrity relies on unique partial indexes and conditional atomic updates, so a replica set is optional functionally but recommended for availability and backups. Indexes are created by Mongoose on startup; for a large production database create them in a controlled step.
- **Plan limits are enforced** (seats, storage, and AI credits when `AI_TOKENS_PER_CREDIT` is set) through `services/planLimits.service.js`, using the values stored on each organization. There is no plan-to-limits table: new organizations get the schema defaults (5 seats, 1 GB), so **set real limits per organization (super-admin `PATCH /platform/organizations/:id/limits`) before onboarding real tenants**, and review organizations that already exceed them (they keep working but cannot grow). `featureFlags` are still not enforced.
- **No migrations framework.** Schema changes are additive today. Plan data migrations explicitly before any change that is not backward compatible.
- **AI image is unbuilt.** `ai/Dockerfile` exists but Docker was not available during development, so it has never been built or run.

## 3. Configuration and secrets

- Generate fresh strong values for `JWT_SECRET`, `JWT_REFRESH_SECRET` and (if used) `SESSION_SECRET`; never reuse development values. Rotating the JWT secrets signs everyone out.
- Set `NODE_ENV=production`: cookies become `Secure`, `trust proxy` is set to 1 (the API must sit behind exactly one trusted proxy, otherwise client IPs and rate limits are wrong), and morgan uses `combined`.
- Set `CLIENT_URL` to the exact production origin (it drives CORS and email links) and keep cookie names identical between API and `NEXT_PUBLIC_CSRF_COOKIE_NAME`.
- AI: generate new ES256 key pairs for production with `backend/scripts/generate-ai-keys.js`; the Groq key lives only in the AI service environment; keep `AI_LIVE_TOOLS_ENABLED=false` until the checklist in the AI operations guide is completed. Use a secrets manager, not files in the repository. `ai/keys/`, `.env` files and `uploads/` must never be committed (they are gitignored).
- Remove or do not run `backend/scripts/seed-demo-users.js` in production (it creates users with a known password).

## 4. Security prerequisites

- HTTPS everywhere with HSTS at the proxy; security headers are already set by Helmet on the API, but the Next.js app needs its own header and CSP decision.
- Keep MongoDB, Redis, Qdrant, the AI service (port 8001) and the internal listener (5002) off the public internet; only the frontend and the API should be reachable.
- Review the open items in [project-status.md](project-status.md) before go-live.
- Who may invite people stays as it is (only `org-admin` and `admin`). Organization deletion and data export do not exist yet.

## 5. Backups and recovery

- **MongoDB:** scheduled snapshots or `mongodump`, tested restores. It is the source of truth for everything including AI usage records.
- **File storage:** back up the storage volume together with the database, they reference each other (document rows point to blob keys).
- **Redis:** treated as rebuildable (OTP, caches, queues). Pending emails and unsent notifications are recoverable from MongoDB (`EmailOutbox`, reconciliation job).
- **Vector index (Qdrant):** derived data. After a loss, re-embed from MongoDB through the embedding administration endpoints. Do not back it up as a primary store.
- Document a recovery order: MongoDB, storage, Redis, API, frontend, then AI workers and Qdrant.

## 6. Monitoring

- Liveness: `GET /health` on the API. AI readiness: `GET /api/v1/ai/status` and the platform status endpoint (super-admin).
- Collect the API logs (morgan access log plus `[http] METHOD path -> status code` lines for 5xx; stack traces are logged server-side only), MongoDB and Redis metrics, queue depth for the email worker, SSE connection counts, disk usage of the storage volume.
- AI: usage and cost records (`AiUsageEvent`), ingestion and embedding job states, platform control state.
- Alert on: API 5xx rate, login failures spike, Redis or MongoDB unavailable, email dead-letter growth, disk usage, AI error rate and quota exhaustion.

## 7. Rollback

- Keep the previous frontend build and API release available; deployments of the two are independent but the API contract is versioned only by path (`/api/v1`), so deploy the API first for backward-compatible changes.
- Database changes so far are additive, so rolling back code does not require rolling back data. Take a snapshot before any release that adds an index or changes a model.
- AI can be turned off without a deploy: organization switch, `AI_GLOBAL_ENABLED`, and the super-admin platform control for live tools.

## 8. Pre-launch checklist

- [ ] Secrets generated and stored in a secrets manager; no `.env` in images or the repository
- [ ] HTTPS, one trusted proxy, exact `CLIENT_URL`, matching cookie names
- [ ] MongoDB and Redis authenticated and private; backups scheduled and a restore tested
- [ ] SMTP verified (OTP, invitation, notification email)
- [ ] LiveKit verified (join, webhook, kick)
- [ ] Single API instance, or rate-limit store and job leadership solved
- [ ] Storage volume persistent and backed up
- [ ] Monitoring and alerts in place
- [ ] Decision recorded on the items listed under "Needs decision" in [project-status.md](project-status.md)
- [ ] If AI is enabled: complete the rollout checklist in [ai/ai-operations.md](ai/ai-operations.md)
