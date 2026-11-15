# Sync OS — Backend

Node.js / Express / MongoDB / Redis API for Sync OS — a multi-tenant SaaS workspace. This
README is the quick-start; for how the system actually works, read:

- [`docs/authentication.md`](../docs/authentication.md) — authentication, tokens, sessions, CSRF, rate limiting
- [`docs/rbac-multi-tenancy.md`](../docs/rbac-multi-tenancy.md) — organizations, roles, permissions, isolation
- [`docs/api-reference.md`](../docs/api-reference.md) — every route, request/response shape, error codes

## Prerequisites

- Node.js (see `package.json` for dependency versions; developed against Node 20+)
- MongoDB running locally (or reachable via `MONGO_URI`)
- Redis running locally (or reachable via `REDIS_URL`) — used for OTP codes and password-reset tokens

## Setup

```bash
npm install
cp .env.example .env   # then set MONGO_URI, JWT_SECRET, JWT_REFRESH_SECRET
npm run dev
```

The server logs `Sync Os backend listening on port <PORT>` on success and exposes
`GET /health` for a liveness check.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MONGO_URI` | ✅ | – | MongoDB connection string |
| `JWT_SECRET` | ✅ | – | Access token signing secret |
| `JWT_REFRESH_SECRET` | ✅ | – | Refresh token signing secret (must differ from `JWT_SECRET`) |
| `PORT` | | `5000` | HTTP port |
| `NODE_ENV` | | `development` | `production` enables `secure` cookies, HSTS-relevant Helmet defaults, combined logging |
| `CLIENT_URL` | | `http://localhost:3000` | Used to build email links (reset/invite URLs) |
| `REDIS_URL` | | `redis://127.0.0.1:6379` | OTP + password-reset token storage |
| `JWT_ACCESS_EXPIRES_IN` | | `15m` | Access token TTL |
| `JWT_REFRESH_EXPIRES_IN` | | `7d` | Refresh token TTL |
| `AUTH_ACCESS_COOKIE_NAME` | | `sync_access_token` | Access token cookie name |
| `AUTH_REFRESH_COOKIE_NAME` | | `sync_refresh_token` | Refresh token cookie name |
| `AUTH_CSRF_COOKIE_NAME` | | `sync_csrf_token` | CSRF token cookie name |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE` | | – | SMTP transport for outgoing email |
| `EMAIL_SERVICE`/`EMAIL_USER`/`EMAIL_PASSWORD` | | `gmail` | Alternative: nodemailer "well-known service" transport |
| `EMAIL_FROM_NAME` | | `Sync Os` | From-name on outgoing email |

If neither SMTP nor `EMAIL_SERVICE` credentials are configured, outgoing email is a no-op in
non-production — emails are logged to the console (`[email:dev]`) instead of sent, which is
how local development works without a real mail provider.

> **If you change `AUTH_ACCESS_COOKIE_NAME` (or any cookie name) in `.env`, every part of the
> codebase that reads that cookie reads it through `AUTH_CONSTANTS`, not a hardcoded string —
> confirm this stays true after any auth-middleware change. A prior version of
> `authenticate.js` hardcoded the default name and silently broke auth whenever the cookie
> name was customized; this is exactly the kind of regression the test suite (`npm test`) is
> meant to catch.**

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start with `nodemon` (auto-restart on file change) |
| `npm start` | Start once, no auto-restart (production-style) |
| `npm test` | Run the Jest + Supertest suite (`tests/`) |

### Running tests

Tests connect to a **separate database** (`syncos_test` by default, overridable via
`TEST_MONGO_URI`) against the same MongoDB/Redis instance used for local dev — they will not
touch your dev data. `tests/setup-env.js` sets `NODE_ENV=test` and the test Mongo URI before
any application code loads.

```bash
npm test
```

Test layout:

```
tests/
├── setup-env.js              # env overrides, loaded before everything else
├── helpers/db.js             # connect/clear/disconnect the test database
├── unit/                     # pure functions — no DB, no HTTP
│   ├── rbac-middleware.test.js
│   └── ownership-utils.test.js
└── integration/              # real Mongo (+ Redis for OTP), real Express app
    ├── checkOwnership.test.js
    └── onboarding-flow.test.js
```

## Folder structure

```
src/
├── app.js              # Express app assembly (middleware order matters — see auth-system.md §11)
├── server.js            # process entrypoint: connect Mongo/Redis, then listen
├── config/               # env, db, redis, mailer
├── constants/            # roles, permissions, rolePermissions, audit events, auth constants
├── controllers/          # thin — parse request, call a service, shape the response
├── services/             # all business logic lives here
├── middlewares/          # authenticate, authorize, checkPermission, checkOwnership, csrf, rate-limit, validate, error
├── models/               # Mongoose schemas
├── routes/               # route wiring only — no logic
├── utils/                # ownership predicates (can*.js), jwt, cookies, crypto, slugify, etc.
└── validations/          # Zod schemas, one file per route group
```

**Layering rule:** `routes → controllers → services → utils/models`. Controllers never talk
to Mongoose directly and never contain permission logic — see
`rbac-multi-tenant-architecture.md` §1 and §8 for why.
