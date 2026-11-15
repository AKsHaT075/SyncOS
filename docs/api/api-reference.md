# Sync OS — Backend API Reference

Companion reference to `auth-system.md` and `rbac-multi-tenant-architecture.md`. Those two
documents explain *why* the system works the way it does; this one is the practical
"what do I actually call" reference — every route, who may call it, what it expects, and what
it returns.

All routes are mounted under **`/api/v1`**. All request/response bodies are JSON
(`Content-Type: application/json`). All responses include a top-level `success: boolean`.

**Conventions used below:**
- **Auth** column: `none` (public), `authenticate` (any logged-in user), or a specific role/
  permission gate.
- **CSRF** column: whether the global CSRF middleware applies (see `auth-system.md` §11).
  Every route is CSRF-protected by default; only the explicitly exempted paths are marked
  `exempt`.
- Request bodies shown are the Zod-validated shape — anything not listed is rejected or
  stripped.

---

## Auth — `/api/v1/auth`

| Method & Path | Auth | CSRF | Body | Notes |
|---|---|---|---|---|
| `GET /csrf-token` | none | n/a (GET) | – | Returns `{ csrfToken }`, sets the CSRF cookie |
| `POST /register` | none | exempt | `{ firstName, lastName, email, password }` | `authLimiter` (10/15min). Password: 8–128 chars, needs upper+lower+digit |
| `POST /verify-email` | none | exempt | `{ email, otp }` (otp = 6 chars) | `otpLimiter` (5/15min) |
| `POST /resend-otp` | none | exempt | `{ email }` | `otpLimiter` |
| `POST /login` | none | exempt | `{ email, password }` | `authLimiter`. Sets access/refresh/CSRF cookies |
| `POST /refresh` | none (reads refresh cookie) | exempt | – | Rotates refresh token, reissues all 3 cookies |
| `POST /logout` | none (reads cookies) | **enforced** | – | Revokes current device's session |
| `POST /logout-all` | `authenticate` | **enforced** | – | Bumps `tokenVersion`, revokes every session |
| `GET /me` | `authenticate` | n/a (GET) | – | Returns `{ user }` (`toSafeObject()`) |
| `PATCH /me` | `authenticate` | **enforced** | `{ firstName?, lastName?, skills? }` (strict, at least one field) | Edit own profile. Role, email and organization cannot be set here. Audit: `user.profile_updated` |
| `POST /change-password` | `authenticate` | **enforced** | `{ currentPassword, newPassword }` (new password follows the register rules and must differ) | `authLimiter`. `400 INVALID_CURRENT_PASSWORD` (counts toward lockout, `423 ACCOUNT_LOCKED`). Success bumps `tokenVersion`, revokes every session and clears cookies, so the client must sign in again. Audit: `auth.password_changed` |
| `GET /sessions` | `authenticate` | n/a (GET) | – | List this user's active/past sessions |
| `DELETE /sessions/:sessionId` | `authenticate` | **enforced** | – | Revoke one specific device |
| `POST /forgot-password` | none | exempt | `{ email }` | `passwordResetLimiter` (5/15min). Always 200, no enumeration |
| `POST /reset-password` | none | exempt | `{ email, token, password }` | `passwordResetLimiter`. Bumps `tokenVersion`, revokes all sessions |

**`POST /login` response:** `{ success: true, accessToken, user }` (refresh/CSRF tokens are
cookie-only, not in the body).

**`/me` → `user` shape** (`User.toSafeObject()`):
```json
{
  "id", "firstName", "lastName", "fullName", "email",
  "role", "permissions": ["..."],
  "organization": "id|null", "team": "id|null",
  "position", "skills": [],
  "emailVerified", "isActive", "hasCreatedOrganization",
  "createdAt", "updatedAt"
}
```

## Organizations — `/api/v1/organizations`

| Method & Path | Auth | CSRF | Body | Notes |
|---|---|---|---|---|
| `GET /me` | `authenticate` | n/a (GET) | – | Returns `{ organizations: [...] }` — orgs the caller belongs to (today: 0 or 1) |
| `PATCH /me` | `authenticate` + `requireOrgAccess` + role `org-admin` | enforced | `{ name?, logo?, timeZone? }` (strict, at least one; `timeZone` must be a valid IANA zone, stored as `settings.timezone`) | Owner edits organization details. Others get 403. Audit: `org.updated` |
| `GET /me/usage` | `org-admin`, `admin` | n/a (GET) | – | `{ usage: { plan, seats: { used, pendingInvitations, limit }, storage: { usedBytes, limitBytes, limitGB }, aiCredits: { limit, enforced } } }` |
| `POST /` | `authenticate` | enforced | `{ name }` (2–120 chars) | Creates the org, caller becomes `ORG_ADMIN`. `409 ORGANIZATION_ALREADY_CREATED` if `hasCreatedOrganization` is already true |

**Organization shape** (`Organization.toSafeObject()`):
```json
{ "id", "name", "slug", "logo", "timeZone", "plan", "limits": { "seats", "aiCredits", "storageGB" },
  "featureFlags": {}, "isActive", "createdAt", "updatedAt" }
```

## Invitations — `/api/v1/invitations`

| Method & Path | Auth | CSRF | Body / Query | Notes |
|---|---|---|---|---|
| `POST /` | `authenticate` + `authorize(ORG_ADMIN)` | enforced | `{ email, role }` — role ∈ `HR\|MANAGER\|EMPLOYEE` | `409 INVITE_ALREADY_PENDING` if one is already outstanding for that email |
| `GET /` | `authenticate` + `authorize(ORG_ADMIN)` | n/a (GET) | `?status=pending\|accepted\|revoked\|expired&page=&limit=` | Always scoped to caller's org |
| `POST /accept` | none (token-based) | **exempt** | `{ token, firstName, lastName, password }` | Creates the user, assigns the invited role + org |
| `POST /:id/resend` | `authenticate` + `authorize(ORG_ADMIN)` | enforced | – | New token + new 7-day expiry; `409` if already accepted |
| `POST /:id/revoke` | `authenticate` + `authorize(ORG_ADMIN)` | enforced | – | Status → `revoked`; `409` if already accepted |

**List response:** `{ success, invitations: [{ id, email, role, invitedBy, status, expiresAt, acceptedAt, revokedAt, createdAt }], pagination: { page, limit, total, pages } }`

## Audit logs — `/api/v1/audit-logs`

| Method & Path | Auth | CSRF | Query | Notes |
|---|---|---|---|---|
| `GET /` | `authenticate` + `authorize(ORG_ADMIN)` | n/a (GET) | `?action=&userId=&startDate=&endDate=&page=&limit=` | Always scoped to caller's org; `user` is populated with `firstName lastName email` |

**Response:** `{ success, logs: [...AuditLog docs...], pagination: { page, limit, total, pages } }`

## Platform administration — `/api/v1/platform/organizations`

Entire router requires `authenticate` + `authorize(SUPER_ADMIN)`. Touches `Organization`
metadata only — see `rbac-multi-tenant-architecture.md` §12 for why that boundary matters.

| Method & Path | Body / Query | Notes |
|---|---|---|
| `GET /` | `?search=&page=&limit=` | Search by name (case-insensitive regex) |
| `GET /:id` | – | Single org |
| `PATCH /:id/plan` | `{ plan }` — `free\|starter\|pro\|enterprise` | Audit: `ORG_PLAN_CHANGED` |
| `POST /:id/suspend` | `{ reason? }` | Sets `isActive: false`. Audit: `ORG_SUSPENDED` |
| `POST /:id/reactivate` | – | Clears suspension. Audit: `ORG_REACTIVATED` |
| `PATCH /:id/limits` | `{ seats?, storageGB?, aiCredits? }` (strict, at least one; seats and storage must be positive) | Changes the plan limits that are enforced. Audit: `org.limits_changed` |
| `PATCH /:id/feature-flags` | `{ featureFlags: { [key]: boolean } }` | Merges into existing flags |

All responses: `{ success, organization }` (single) or `{ success, organizations, pagination }` (list).

---

## Error response shape

Every error follows the same envelope (`middlewares/error.middleware.js`):

```json
{
  "success": false,
  "code": "SOME_CODE",
  "message": "Human-readable message",
  "details": null,
  "stack": "... (non-production only)"
}
```

`statusCode` drives the HTTP status; `code` is the stable, machine-checkable identifier
(prefer switching on this over the message string).

### Error codes in use

| Code | HTTP | Where it shows up |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing/invalid/expired access token |
| `INVALID_CREDENTIALS` | 401 | Login: wrong email or password |
| `ACCOUNT_LOCKED` | 423 | Login: 5+ failed attempts within 15 min |
| `INVALID_CURRENT_PASSWORD` | 400 | Change password: the current password is wrong |
| `SEAT_LIMIT_REACHED` | 403 | Inviting or accepting when the plan's seats are used |
| `STORAGE_LIMIT_REACHED` | 413 | Upload, new version or version restore beyond the plan's storage |
| `EMAIL_NOT_VERIFIED` | 403 | Login before OTP verification |
| `EMAIL_ALREADY_VERIFIED` | 409 | Re-verifying an already-verified email |
| `EMAIL_EXISTS` | 409 | Register / accept-invite with a duplicate email |
| `INVALID_OTP` | 400 | Wrong/expired OTP |
| `INVALID_REFRESH_TOKEN` | 401 | Refresh: expired, revoked, reused, or version-mismatched |
| `MISSING_REFRESH_TOKEN` | 401 | Refresh called with no refresh cookie |
| `INVALID_RESET_TOKEN` | 400 | Wrong/expired password-reset token |
| `SESSION_NOT_FOUND` | 404 | Revoking a session id that doesn't belong to the caller |
| `USER_NOT_FOUND` | 404 | Target user lookup failed |
| `FORBIDDEN` | 403 | `authorize`/`checkPermission` denial, or in-org ownership denial |
| `NOT_FOUND` | 404 | `checkOwnership` cross-org lookup, or any missing resource |
| `NO_ORGANIZATION` | 400 | Inviting users before the caller belongs to an org |
| `INVALID_INVITE_ROLE` | 403 | Inviting a role outside `HR/MANAGER/EMPLOYEE` |
| `INVALID_INVITE` | 400 | Accepting an invalid/expired/already-used invite token |
| `INVITE_ALREADY_PENDING` | 409 | Re-inviting an email with an outstanding invite |
| `INVITE_ALREADY_ACCEPTED` | 409 | Resend/revoke on an already-accepted invite |
| `ORGANIZATION_ALREADY_CREATED` | 409 | Second `POST /organizations` from the same user |
| `CSRF_VALIDATION_FAILED` | 403 | Missing/mismatched CSRF cookie+header |
| `VALIDATION_ERROR` | 400 | Zod schema rejection (`details` has the flattened Zod error) |
| `ROUTE_NOT_FOUND` | 404 | No matching route at all |
| `INTERNAL_SERVER_ERROR` | 500 | Unhandled error (message is generic in production) |

---

## Rate limits at a glance

| Limiter | Limit/window | Applied to |
|---|---|---|
| `apiLimiter` | 300 / 15 min | every request, globally |
| `authLimiter` | 10 / 15 min | `/auth/register`, `/auth/login` |
| `otpLimiter` | 5 / 15 min | `/auth/verify-email`, `/auth/resend-otp` |
| `passwordResetLimiter` | 5 / 15 min | `/auth/forgot-password`, `/auth/reset-password` |

## Required headers for mutating requests

Outside the CSRF-exempt list, every non-`GET`/`HEAD`/`OPTIONS` request must include the
`X-CSRF-Token` header set to the current value of the CSRF cookie. Get a fresh one via
`GET /api/v1/auth/csrf-token`, or simply reuse the one reissued by the last login/refresh
call.

## Calendar

See [calendar.md](../modules/calendar.md) for the full endpoint list, scopes, access rules, timezone, recurrence and reminder behaviour (`/api/v1/calendar`).

## Assets

See [assets.md](../modules/assets.md) for the endpoint list, role matrix, lifecycle, integrity model, license handling and alerts (`/api/v1/assets`).

## Analytics & Reporting

See [analytics.md](../modules/analytics.md) for roles, endpoints, metric definitions, date/timezone rules, caching and limits (`/api/v1/analytics`).

## Notifications

See [notifications.md](../modules/notifications.md) (`/api/v1/notifications`).
