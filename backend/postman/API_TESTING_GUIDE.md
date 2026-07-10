# SyncOS Backend — Postman Testing Guide

Import `SyncOS.postman_collection.json` and `SyncOS.postman_environment.json` into Postman, select the **SyncOS - Local** environment, and run requests **top-to-bottom within each folder** — later requests reuse variables (`csrfToken`, `accessToken`, `organizationId`, `invitationToken`, `invitationId`, `sessionId`) captured automatically by earlier ones via test scripts.

## Setup

1. Backend env vars required to start the server (`backend/.env`): `MONGO_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`. Optional: `PORT` (default `5000`), `REDIS_URL`, `CLIENT_URL`, `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`SMTP_PORT` (email — without SMTP configured, check server console logs for OTP/reset links in dev).
2. Start the server: `cd backend && npm run dev` (or `npm start`).
3. In Postman, set environment variable `baseUrl` to match (default `http://localhost:5000`).
4. Make sure Postman's cookie jar is enabled for `localhost` (Settings → General → "Automatically follow redirects" doesn't matter, but cookies must be on — they are by default).

## Auth model (read this before testing)

- **Access token**: returned in the JSON body on login/refresh AND set as cookie `sync_access_token`. The collection sends it explicitly as `Authorization: Bearer {{accessToken}}` so it works even if cookies aren't replayed.
- **Refresh token**: cookie-only (`sync_refresh_token`, httpOnly). Used by `POST /auth/refresh`.
- **CSRF token**: double-submit pattern. Cookie `sync_csrf_token` (readable by JS) must match header `X-CSRF-Token` on every mutating request (anything other than GET/HEAD/OPTIONS), **except** these exempt paths: `/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/resend-otp`, `/auth/verify-email`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/csrf-token`, `/invitations/accept`, `/health`.
- All protected endpoints also require `Authorization: Bearer <accessToken>` (or the cookie) — missing/invalid → `401 UNAUTHENTICATED`. Wrong role → `403 FORBIDDEN`.

## Roles

`super-admin` (platform-wide) · `org-admin` (created the org / can invite & manage it) · `hr` · `manager` · `employee` · `guest`. Invitations can only grant `hr`, `manager`, or `employee`. `super-admin` has no API-driven way to be granted — set it directly in MongoDB for a test user when testing the Platform Admin folder.

---

## Endpoint Reference

### Health

| Method | Path | Auth | Body | 200/201 Response |
|---|---|---|---|---|
| GET | `/health` | none | — | `{ success: true, status: "ok" }` |

### Auth — `/api/v1/auth`

| # | Method | Path | Auth / CSRF | Request Body | Success Response |
|---|---|---|---|---|---|
| 1 | GET | `/csrf-token` | none | — | `{ success: true, csrfToken: "<hex>" }` (200) |
| 2 | POST | `/register` | none, CSRF-exempt | `{ firstName, lastName, email, password }` | `{ success: true, message, user: {...} }` (201) |
| 3 | POST | `/verify-email` | none, CSRF-exempt | `{ email, otp }` (otp = 6 chars) | `{ success: true, message, user: {...} }` (200) |
| 4 | POST | `/resend-otp` | none, CSRF-exempt | `{ email }` | `{ success: true, message }` (200) |
| 5 | POST | `/login` | none, CSRF-exempt | `{ email, password }` | `{ success: true, accessToken, user: {...} }` (200) + sets cookies |
| 6 | POST | `/refresh` | refresh cookie required, CSRF-exempt | — | `{ success: true, accessToken, user: {...} }` (200) + rotates cookies |
| 7 | GET | `/me` | Bearer | — | `{ success: true, user: {...} }` (200) |
| 8 | GET | `/sessions` | Bearer | — | `{ success: true, sessions: [...] }` (200) |
| 9 | DELETE | `/sessions/:sessionId` | Bearer + CSRF | — | `{ success: true, message }` (200) |
| 10 | POST | `/forgot-password` | none, CSRF-exempt | `{ email }` | `{ success: true, message }` (200, always generic) |
| 11 | POST | `/reset-password` | none, CSRF-exempt | `{ email, token, password }` | `{ success: true, message }` (200) — revokes all sessions |
| 12 | POST | `/logout` | Bearer + CSRF | — | `{ success: true, message }` (200) + clears cookies |
| 13 | POST | `/logout-all` | Bearer + CSRF | — | `{ success: true, message }` (200) + clears cookies |

**Password rule:** 8–128 chars, ≥1 lowercase, ≥1 uppercase, ≥1 digit (e.g. `Password123`).

**`user` object shape** (returned by register/verify-email/login/me):
```json
{
  "id": "...", "firstName": "...", "lastName": "...", "fullName": "...",
  "email": "...", "role": "employee", "permissions": [],
  "organization": null, "team": null, "position": "", "skills": [],
  "emailVerified": false, "isActive": true, "hasCreatedOrganization": false,
  "createdAt": "...", "updatedAt": "..."
}
```

**Error codes you'll see while testing:** `EMAIL_EXISTS` (409), `INVALID_OTP` (400), `INVALID_CREDENTIALS` (401), `ACCOUNT_LOCKED` (423, after 5 failed logins for 15 min), `EMAIL_NOT_VERIFIED` (403), `CSRF_VALIDATION_FAILED` (403), `UNAUTHENTICATED` (401), `FORBIDDEN` (403).

### Organizations — `/api/v1/organizations`

| Method | Path | Auth | Request Body | Success Response |
|---|---|---|---|---|
| POST | `/` | Bearer + CSRF | `{ name }` (2–120 chars) | `{ success: true, organization: {...} }` (201). Caller's role becomes `org-admin`. |
| GET | `/me` | Bearer | — | `{ success: true, organizations: [...] }` (200) |

### Invitations — `/api/v1/invitations`

| Method | Path | Auth | Request Body / Query | Success Response |
|---|---|---|---|---|
| POST | `/` | Bearer (org-admin) + CSRF | `{ email, role }` — role ∈ `hr`,`manager`,`employee` | `{ success: true, message }` (201) |
| GET | `/` | Bearer (org-admin) | query: `status?` (pending/accepted/revoked/expired), `page?`, `limit?` (≤100) | `{ success: true, invitations: [...], pagination: {...} }` (200) |
| POST | `/accept` | none, CSRF-exempt | `{ token, firstName, lastName, password }` | `{ success: true, user: {...} }` (201) |
| POST | `/:id/resend` | Bearer (org-admin) + CSRF | — | `{ success: true, invitation: {...} }` (200) |
| POST | `/:id/revoke` | Bearer (org-admin) + CSRF | — | `{ success: true, invitation: {...} }` (200) |

**Error codes:** `NO_ORGANIZATION` (400 — inviter has no org), `INVALID_INVITE_ROLE` (403), `EMAIL_EXISTS` (409), `INVITE_ALREADY_PENDING` (409), `INVALID_INVITE` (400, on accept), `NOT_FOUND` (404), `INVITE_ALREADY_ACCEPTED` (409). Invite tokens expire after 7 days.

### Audit Logs — `/api/v1/audit-logs`

| Method | Path | Auth | Query | Success Response |
|---|---|---|---|---|
| GET | `/` | Bearer (org-admin) | `action?`, `userId?`, `startDate?`, `endDate?`, `page?`, `limit?` (≤100) | `{ success: true, logs: [...], pagination: {...} }` (200), scoped to caller's org |

### Platform Admin — `/api/v1/platform/organizations` (super-admin only)

| Method | Path | Request Body | Success Response |
|---|---|---|---|
| GET | `/` | query: `search?`, `page?`, `limit?` | `{ success: true, organizations: [...], pagination: {...} }` (200) |
| GET | `/:id` | — | `{ success: true, organization: {...} }` (200) |
| PATCH | `/:id/plan` | `{ plan }` — `free`\|`starter`\|`pro`\|`enterprise` | `{ success: true, organization: {...} }` (200) |
| POST | `/:id/suspend` | `{ reason? }` (≤500 chars) | `{ success: true, organization: {...} }` (200) |
| POST | `/:id/reactivate` | — | `{ success: true, organization: {...} }` (200) |
| PATCH | `/:id/feature-flags` | `{ featureFlags: { [key]: boolean } }` | `{ success: true, organization: {...} }` (200) |

All require `Authorization: Bearer <accessToken>` + `X-CSRF-Token` (except the two GETs) for a user whose `role` is `super-admin`.

---

## Manual test checklist

Run in this order against a fresh database:

- [ ] `GET /health` → 200
- [ ] `Auth → 1. Get CSRF Token` → 200, `csrfToken` saved
- [ ] `Auth → 2. Register` → 201; grab the OTP from email/server logs, set `otp` env var
- [ ] `Auth → 3. Verify Email` → 200
- [ ] `Auth → 5. Login` → 200, `accessToken` + `csrfToken` saved
- [ ] `Auth → 7. Me` → 200, matches registered user
- [ ] `Organizations → 1. Create Organization` → 201, `organizationId` saved; re-run `Me` to confirm `role` is now `org-admin`
- [ ] `Invitations → 1. Invite User` → 201; grab token from email/logs, set `invitationToken`
- [ ] `Invitations → 2. List Invitations` → 200, status `pending`, `invitationId` saved
- [ ] Open a **second** Postman environment/tab (or just swap `userEmail`/`accessToken` temporarily) and run `Invitations → 3. Accept Invitation` with the invitee's details → 201
- [ ] `Invitations → 5. Revoke Invitation` on a separate pending invite → 200, status becomes `revoked`
- [ ] `Audit Logs → List Audit Logs` (as org-admin) → 200, should show register/login/invite events
- [ ] `Auth → 8. List My Sessions` → 200, `sessionId` saved
- [ ] `Auth → 9. Revoke a Session` on a non-current session → 200
- [ ] `Auth → 13. Logout All Devices` → 200; subsequent `Me` call with the old `accessToken` should now fail once the token expires/is checked against `tokenVersion`
- [ ] (Optional, needs a manually-promoted `super-admin` user) `Platform Admin` folder end-to-end: list → get by id → change plan → suspend → reactivate → update feature flags

## Performance notes

- **Register/password-reset/invite endpoints are now fast (~500ms)** — emails are queued asynchronously instead of blocking the request. A background worker processes the queue and retries failed sends up to 3 times.
- **SMTP configuration** — If configured, emails send in the background. If not configured, emails log to console in dev mode. Either way, the HTTP request returns immediately.

## Notes / known repo cleanup

- `backend/src/routes/index 2.js` is a stray leftover file (not wired into `app.js`) — safe to delete, not used by this collection.
