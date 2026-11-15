# Notifications — architecture, retention and operations

Centralised, organization-scoped, permission-aware notifications with in-app,
real-time (SSE) and email delivery. **MongoDB is the source of truth**; Redis
and SSE are best-effort delivery layers on top of it.

```
 business service ──► notificationEvents ──► notify() ──► MongoDB (Notification)  ◄── source of truth
   (task, project,        (one fn per          │  1. validate recipients
    meeting, team,         domain event)       │  2. apply preferences
    people, document)                          │  3. idempotent upsert (dedupeKey)
                                               ▼  then, each step isolated & best-effort:
                              ┌────────────────┴─────────────────┐
                              ▼                                  ▼
                   notificationHub.publish()            queueNotificationEmail()
                   local SSE + Redis Pub/Sub            Redis email queue (jobId-deduped)
                              │                                  │
                  browsers (1 stream / browser)         email worker ─► SMTP
```

## Files

| Area | Files |
|---|---|
| Models | `models/Notification.js`, `NotificationPreference.js`, `EmailOutbox.js` |
| Catalogue | `constants/notificationTypes.js` (every type: category, link, email, copy), `constants/notification.constants.js` |
| Core | `services/notification.service.js` (notify, list, read, dismiss, preferences) |
| Triggers | `services/notificationEvents.js` — called by task/project/meeting/meetingRequest/team/people/documentShare/documentVersion services |
| Access | `services/notificationAccess.service.js` (link + availability per recipient) |
| Real-time | `services/notificationHub.js` (SSE + Redis Pub/Sub), `controllers/notification.controller.js#stream` |
| Email | `services/notificationEmail.service.js`, `services/email-queue.js`, `utils/emailTemplates.js` |
| Jobs | `services/notificationJobs.js` (meeting reminders, email sweeper) — started in `server.js` |
| API | `routes/notification.routes.js`, `validations/notification.validation.js` |
| Frontend | `frontend/src/features/notifications/*`, `app/dashboard/notifications/page.js` |

## API (all require sign-in and a non-blocked organization member)

| Method & path | Purpose |
|---|---|
| `GET /notifications?cursor&limit&status=all\|unread&category=` | Cursor-paginated feed (newest first) |
| `GET /notifications/unread-count` | `{count, capped}` (capped at 100 → "99+") |
| `POST /notifications/:id/read` · `POST /notifications/read-all` | Mark read (optionally per category) |
| `DELETE /notifications/:id` | Dismiss (soft delete) |
| `GET /notifications/preferences` · `PUT /notifications/preferences` | Per user + organization |
| `GET /notifications/stream` | Server-Sent Events |

There is **no create endpoint**. Only server-side events create notifications.

## Security model

* Every query is filtered by `{recipient: me, organization: myOrg}`. Someone
  else's id, a dismissed id and a nonexistent id are all `404`.
* `notify()` re-validates every recipient (same organization, active, not
  blocked) and never notifies the actor about their own action.
* Titles are generic ("Task assigned"); resource names live only in `message`.
  On every read the server checks, **for the current user, right now**, whether
  the destination is still accessible (same rules the modules enforce, batched
  per resource type). If not: `link: null`, `available: false`, and the message
  is replaced with "You no longer have access to this item." (names withheld).
  Types such as "removed from a project" never link.
* `security` notifications ignore preferences and cannot be disabled.
* Blocked / removed people can't use the app. They receive **one generic email**
  (organization name only) and their live streams are closed immediately. No
  in-app row exists for them.

## Deduplication

`dedupeKey = <type>:<resourceId>:<recipientId>:<occurrence>`, enforced by a
unique `{recipient, dedupeKey}` index and an idempotent upsert, so concurrent
duplicates collapse to one row. `occurrence` identifies **one specific event**
(a submission/review sub-document id, a share timestamp, a version number, a
document's `updatedAt`, …). The same event delivered twice → same key →
suppressed; a genuinely new event (assigned again after being unassigned) →
different `occurrence` → delivered. Callers must supply it; `notify()` throws
without one. A dismissed notification keeps its row until retention, so a
replay can't resurrect it.

## Retention (90 days)

Every notification — **unread, read or dismissed** — expires 90 days after
creation. One TTL index on `createdAt` (`expireAfterSeconds = 90 d`, not
conditional on any state) enforces this uniformly; reading or dismissing never
extends or shortens a notification's life.

MongoDB's TTL monitor runs about once a minute and may lag under load, so reads
also apply the same cutoff (`createdAt >= now - 90 d`) and never show or count
an expired row even before it is physically deleted. Changing
`NOTIFICATION_RETENTION_DAYS` requires rebuilding the TTL index (`collMod` or
drop/recreate). `EmailOutbox` rows expire after 30 days.

## Real-time delivery

* **SSE** (not WebSockets): one-way, plain HTTP, no new dependency.
* Authenticated like any route (cookie or `Authorization: Bearer`), then
  `requireOrgAccess`. The stream is closed when the access token expires, so a
  revoked session can't hold it open; the client refreshes and reconnects.
* Max 5 streams per user (oldest is dropped). 25 s heartbeat comments.
* **Redis Pub/Sub** bridges instances: `publish()` delivers locally, then
  publishes on `<prefix>:user:<id>`; an instance subscribes to a user's channel
  only while that user has a local connection, and ignores its own echo.
* Best-effort by design: if Redis or a socket fails nothing is lost — the row is
  already in MongoDB and clients resync (`ready` event → unread count + first
  page) on every (re)connect. There is no server-side replay buffer.
* **Browser**: one stream per browser. Tabs elect a leader (Web Locks); the
  leader relays events to other tabs via `BroadcastChannel`. The client uses a
  `fetch` stream with the Bearer token (so it needs no cookie), backs off
  exponentially with jitter, and stops permanently on `blocked` / `removed` /
  `sessions_revoked`.

## Email

* Preferences + per-type eligibility decide whether a notification is emailed;
  only a small high-signal set is eligible (see `notificationTypes.js`).
* Row first, queue second: the notification is persisted with
  `email.status = pending`; after a successful enqueue it becomes `queued`; the
  worker later marks it `sent` or `failed`. Email failures never touch the
  in-app notification.
* **Queue hardening** (`email-queue.js`, backward compatible — OTP, reset,
  invitation and meeting emails keep their API and wording):
  `queue` (ready) → atomic claim into `processing` (Lua) → on failure a
  **delayed** retry set with backoff (5 s, 30 s, 2 min) instead of sleeping in
  the worker → after retries, a **dead-letter** list. Stale claims (worker
  crash) are recovered on start and every 30 s; a job that keeps crashing
  workers is dead-lettered. Jobs with a `jobId` are sent at most once (`done`
  marker + send lock).
* **Durable account emails**: blocked/removed notices are written to
  `EmailOutbox` *before* Redis is touched. The sweeper (every minute) re-queues
  rows that never reached the queue (>2 min `pending`) or were queued but never
  confirmed (>30 min — e.g. Redis lost its data); `jobId` dedupe prevents double
  sends; after 5 failed sweeps a row is marked `failed`.
* Redis keys/channels use `EMAIL_QUEUE_PREFIX` / `NOTIFICATION_CHANNEL_PREFIX`
  (tests use `test:`-prefixed ones so they never touch a dev worker).

## Operations

* Inspect the queue: `getQueueStats()` → `{ready, processing, delayed, dead}`;
  dead jobs: `LRANGE email:dead 0 -1`.
* Meeting reminders: every minute, scheduled meetings starting within 15 minutes
  → one `meeting.reminder` per participant per scheduled start (dedupe key
  includes the start time, so a rescheduled meeting reminds again). In-app only.

## Known limitations

* Account emails are queued through Redis; if Redis stays down they wait in
  `EmailOutbox` until it returns (they are not sent directly over SMTP).
* `SMTP` unset ⇒ emails are only logged (development behaviour).
* No digest/batching, quiet hours, or per-type (vs per-category) preferences.
* Announcements and @mentions are not implemented (no backing feature exists).
* The live stream's identity is checked when it opens and on each token
  expiry (≤ the access-token TTL); blocking/removal also closes it immediately.
