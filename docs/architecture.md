# Architecture

How Sync OS is put together. For module-level detail see [modules.md](modules.md); for the access model see [rbac-multi-tenancy.md](rbac-multi-tenancy.md) and [authentication.md](authentication.md).

## 1. System overview

```
Browser ── Next.js (port 3000) ──► Express API (port 5001, /api/v1) ──► MongoDB
                                      │   │                            Redis
                                      │   ├──► LiveKit server (video rooms, webhook back to the API)
                                      │   └──► SMTP (email)
                                      │
                                      ▼  signed ES256 JWTs, SSE streaming
                           Python AI service (FastAPI, port 8001) ──► Groq
                                      ▲
                    Node internal listener (127.0.0.1:5002) ◄── ingestion and embedding workers (pull jobs)
                                      Qdrant (vector store, used only by Python)
```

Principles that hold everywhere:

1. **Node is the single authority.** Authentication, RBAC, organization isolation, quotas, auditing and every data read for AI happen in Node.
2. **Every query is scoped by `organization`.** Cross-organization and no-access both return 404, never 403, so existence is not revealed.
3. **MongoDB is the source of truth.** Redis, SSE, email queues and vector indexes are derived or best-effort layers that can be rebuilt.
4. **Authorization is evaluated live**, not cached in tokens or indexes, so a membership change takes effect immediately.

## 2. Frontend (`frontend/`)

- **Next.js 15 App Router, JavaScript only.** Routes live in `src/app`; dashboard routes under `src/app/dashboard/*`, public auth pages at the top level, the LiveKit room at `app/meeting-room/[projectId]/[meetingId]`.
- **Feature folders** `src/features/<module>/{components,hooks,services,schemas,utils}`: services wrap Axios calls, hooks wrap TanStack Query, schemas are Zod. Shared UI is in `src/components` (shadcn primitives in `components/ui`, layout in `components/layout`, dashboard cards in `components/dashboard`).
- **State:** server state in TanStack Query (the `QueryProvider` invalidates module keys after any successful mutation); auth/session in a Zustand store (`store/useAuthStore.js`); filters live in the URL where the page is shareable (calendar, inventory, AI conversation).
- **HTTP:** `lib/axios.js` sends the access token, the CSRF header (value read from the CSRF cookie whose name comes from `NEXT_PUBLIC_CSRF_COOKIE_NAME`) and refreshes the token once on 401. The AI chat and notification streams use a `fetch`-based SSE reader because they need a Bearer header.
- **Permissions in the UI** (`constants/permissions.js`, `<Can>`, `usePermission`) only hide controls. The backend is the real check and the two lists must be kept in sync.
- **Role dashboards** (`components/dashboard/views/*`): org admin, HR, manager, employee, guest, super admin. Metrics come from the analytics API; cards still marked with a *Preview* badge use sample data and are listed in [project-status.md](project-status.md).
- **Theme:** the app forces the light theme today. Use semantic Tailwind tokens (`bg-card`, `text-muted-foreground`) in new code so dark mode can be enabled later.

## 3. Backend (`backend/`)

Plain CommonJS Express application.

```
routes/       URL + middleware chain only (authenticate, requireOrgAccess, checkPermission, validateBody/Query)
controllers/  thin: parse request, call a service, shape the response ({ success: true, ...payload })
services/     all business logic and database access
models/       Mongoose schemas, indexes
utils/        pure access predicates (projectAccess, teamAccess, documentAccess, calendarAccess, assetAccess, aiAccess ...)
validations/  Zod schemas
constants/    roles, permissions, rolePermissions, audit events, per-module enums
middlewares/  authenticate, requireOrgAccess, rbac, validate, rate-limit, csrf, error handler
config/       env (validated once), db, redis, mailer
storage/      file storage provider interface (local provider; keys <orgId>/<uuid>)
```

- **Entry points:** `server.js` starts the public API and the loopback-only internal listener (`internalApp.js`, port 5002) used by the AI service and workers. `app.js` builds the Express app. Routes are mounted in `routes/index.js` under `/api/v1`.
- **Middleware order** (`app.js`): Helmet, CORS, the LiveKit webhook (raw body, before JSON parsing, signature verified), JSON parsing, cookies, global rate limit (300 req / 15 min / IP), CSRF protection, routes, 404, error handler. The error handler never returns a stack trace.
- **Errors:** `throw new AppError(message, status, CODE)`; the handler returns `{ success: false, message, code }`.
- **Background work** runs inside the API process (`server.js`): meeting auto-cleanup, notification and meeting reminders, asset alert jobs (via `notificationJobs`), the email worker (Redis-backed queue with retry and dead-letter), and AI jobs (usage recovery and retention). There is no separate job runner to deploy. These timers are not leader-elected, so running several API instances needs the checks in [deployment.md](deployment.md).

## 4. Data model

Every tenant model has an indexed `organization` field. Main relationships:

```
Organization ─┬─ User (role, orgBlocked, team?)           Invitation, Session, RefreshToken, AuditLog
              ├─ Team (lead, members[])
              ├─ Project (owner, members[{user, role}], visibility, team?) ── ProjectResource (files)
              │     ├─ Task (project, assignees[], submissions[], reviews[], attachments, completedAt)
              │     ├─ Meeting (project, participants[], LiveKit room) ── MeetingRequest
              │     └─ (Goal: placeholder only, not implemented)
              ├─ Document ─ DocumentFolder, DocumentVersion (`sharedWith` embedded; trash via `deletedAt`)
              ├─ CalendarEvent (standalone events only) ─ CalendarPreference
              ├─ Notification ─ NotificationPreference, EmailOutbox
              ├─ Asset ─ AssetAssignment (source of truth), AssetMaintenance, AssetCategory, AssetVendor, AssetDocument, AssetCounter
              └─ AI: AiOrgSettings, AIConversation, AiMessage, AiUsageEvent, DocumentIngestionJob, DocumentChunk, EmbeddingJob
Platform (no organization): AiEmbeddingConfig, AiPlatformControl
```

Membership sources of truth: `Team.members/lead` and `Project.owner/members` (read through `utils/projectAccess.js` and `teamAccess.js`). Meetings, tasks and project due dates are **read** by the calendar and analytics from their own collections and are never copied.

## 5. Authentication and RBAC

Short version (full detail in [authentication.md](authentication.md) and [rbac-multi-tenancy.md](rbac-multi-tenancy.md)):

- Access JWT (15 min) and rotating refresh token (7 days) in HTTP-only cookies, CSRF double-submit token, device sessions with revocation, account lockout, Redis-hashed email OTP.
- Roles: `super-admin` (platform only, no tenant content), `org-admin`, `admin` (same powers as org-admin except granting the admin role), `hr`, `manager`, `employee`, `guest` (read-only, only what is explicitly shared).
- Three layers: route permission (`checkPermission`), org access (`requireOrgAccess` blocks `orgBlocked` users with `ORG_BLOCKED`), then resource-level predicates inside services (ownership, membership, visibility).

## 6. Multi-tenancy

One database, one `organization` ObjectId on every tenant document, enforced in the service layer on every query and in unique/partial indexes. Super-admins manage organizations (plan, suspend, flags) through `/api/v1/platform/organizations` but never read tenant content. Plan limits (`limits.seats`, `storageGB`, `aiCredits`) are enforced centrally in `services/planLimits.service.js` (see [modules.md](modules.md), Organizations). `featureFlags` are stored but not enforced.

## 7. Documents and file processing

Uploads go through Multer to a temp directory, are validated (extension allowlist, client-MIME consistency, magic bytes, size limit), stored through the storage provider and the temp file is always removed. Visibility: private (owner and explicit shares only, not admins), team, project (real members only), organization (everyone except guests). Versions are immutable; restoring copies the blob into a new version. Deleting goes to trash; permanent delete is admin only. Task attachments and project resources are separate, project-scoped uploads and are not Documents.

For AI, document changes enqueue an ingestion job (text extraction and chunking in a Python worker, pulling jobs through Node's loopback listener), then an embedding job (embedding worker writes vectors to Qdrant). Nothing in the vector store carries permissions; retrieval is authorized live from the document in MongoDB.

## 8. Redis and background jobs

Redis is used for: OTP and password-reset tokens (hashed), notification fan-out between instances (pub/sub, prefix `notif`), the email queue (prefix `email`), AI rate limits, concurrency slots and quota reservations (Lua scripts), AI single-use token replay protection (in Python) and AI tool budgets. The HTTP rate limiters (`express-rate-limit`) use the default **in-memory store**, so their counters are per process, not shared. Notification delivery degrades to the database if Redis pub/sub is unavailable.

## 9. Real-time and external services

- **Notifications:** MongoDB is the source of truth; the browser holds an SSE stream (`/notifications/stream`) with cross-tab leader election; email is a durable best-effort layer.
- **LiveKit:** the API creates rooms and signs join tokens (`livekit-server-sdk`); the optional webhook (`LIVEKIT_WEBHOOK_ENABLED`) keeps meeting state in sync and is verified by LiveKit's signature, not by login.
- **Email:** Nodemailer over SMTP, sent from the queue.

## 10. AI architecture

`Browser → Node → Python → Groq`. Node signs short-lived ES256 tokens (minimal claims, single use, separate audiences for generate/status/callback); Python verifies with the public key and holds the Groq key, embeddings and retrieval. Python has no database or RBAC; when it needs data or a tool it calls back into Node, which re-checks the user, organization, AI settings and permissions on every call. AI is off per organization by default; live workspace tools are a second switch, off by default, with a platform-wide runtime kill switch. Everything is documented in [ai/ai-overview.md](ai/ai-overview.md), [ai/ai-operations.md](ai/ai-operations.md) and [ai/ai-service-contract.md](ai/ai-service-contract.md); this section does not replace them.
