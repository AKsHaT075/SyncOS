# Sync OS

A multi-tenant company workspace: people, teams, projects, tasks, meetings, documents, calendar, assets, notifications, analytics and an AI assistant, in one secure application. Every organization is isolated from every other, and what each person can see and do is decided on the server by their role and their memberships.

> **Status:** feature-complete for the modules listed below, **not deployed**. See [docs/project-status.md](docs/project-status.md) for the honest per-module status, known gaps and what needs a decision before a deployment.

## Core features

| Area | What it does |
|---|---|
| Authentication and RBAC | Email/OTP signup, JWT access + rotating refresh tokens in HTTP-only cookies, CSRF protection, sessions, lockout, seven roles with permission checks and resource-level rules |
| Organizations and people | Create or join an organization, invitations, role changes, block/remove (blocking removes org access, not login), force password reset, audit log |
| Projects and tasks | Projects with members and roles, tasks with assignees, attachments, submit-for-review and review, archive, activity feeds |
| Teams | Teams with a lead and members, "my team" view |
| Meetings | Scheduled and instant meetings, meeting requests with approval, LiveKit video rooms, participants, kick |
| Documents | Folders, sharing, versions, trash, private/team/project/organization visibility, upload validation |
| Calendar | Personal, team and organization events with recurrence and reminders; meetings, task and project due dates are shown from their own modules |
| Notifications | In-app (live stream), preferences and durable email delivery |
| Assets | Inventory, assignment history, maintenance, catalog, licences, reports, offboarding view |
| Analytics and reports | Role-scoped metrics, dashboards and CSV reports |
| AI Studio | Document question answering with citations and private conversations; optional live workspace lookups (**off by default**) |

## Architecture at a glance

```
Browser ── Next.js 15 (JavaScript) ──► Node/Express API (authority) ──► MongoDB
                                         │      │                      Redis
                                         │      └──► LiveKit (meetings)
                                         ▼
                              Python FastAPI AI service ──► Groq
                              (+ ingestion and embedding workers, Qdrant)
```

Node owns authentication, RBAC, organization isolation, quotas and tool authorization. Python holds the model key and retrieval and has no database or permissions. Details: [docs/architecture.md](docs/architecture.md).

## Technology

- **Frontend:** Next.js 15 (App Router), JavaScript, Tailwind CSS, shadcn/ui, TanStack Query, Zustand, React Hook Form + Zod, Axios, LiveKit components
- **Backend:** Node.js, Express, Mongoose 9 (MongoDB), Redis, Zod, Multer, Nodemailer, livekit-server-sdk, Helmet, express-rate-limit
- **AI service:** Python, FastAPI, Groq (only LLM provider), self-hosted `intfloat/multilingual-e5-small` embeddings, Qdrant
- **Tests:** Jest + Supertest (backend), pytest (AI service), `node --test` (frontend pure utilities)

## Repository layout

```
backend/    Express API (routes -> controllers -> services -> models), tests, scripts, Postman collection
frontend/   Next.js app: src/app (routes), src/features/<module>, src/components, src/lib, src/store
ai/         Python AI service, ingestion and embedding workers, shared test fixtures (ai/contracts/*.json)
docs/       All project documentation (start at docs/README.md)
CLAUDE.md   Working notes for AI coding assistants; also a compact record of design decisions
```

## Prerequisites

- Node.js 20+ and npm
- MongoDB (27017) and Redis (6379) running locally
- Optional: LiveKit server for video meetings (`npm run livekit:dev` in `backend/`), Python 3.11+ (developed on 3.13) for the AI service, a Qdrant server for document search

## Quick start

```bash
# 1. Backend
cd backend
npm install
cp .env.example .env          # set MONGO_URI, JWT_SECRET, JWT_REFRESH_SECRET (the other values have defaults)
npm run dev                   # http://localhost:5001  (health check: GET /health)

# 2. Frontend (new terminal)
cd frontend
npm install
cp .env.example .env.local
npm run dev                   # http://localhost:3000
```

Optional demo data: `node backend/scripts/seed-demo-users.js`.

### AI service (optional)

AI is off for every organization until an admin accepts the disclosure, and the service is not needed for the rest of the product.

```bash
node backend/scripts/generate-ai-keys.js     # writes ai/keys/ (gitignored) and prints the lines for backend/.env and ai/.env
cd ai
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env                         # add GROQ_API_KEY and the printed key lines
set -a; . ./.env; set +a
.venv/bin/uvicorn app.main:build --factory --host 127.0.0.1 --port 8001 --no-access-log
```

The ingestion and embedding workers are separate processes, see [ai/README.md](ai/README.md). Full AI setup, the emergency kill switch and the rollout checklist: [docs/ai/ai-operations.md](docs/ai/ai-operations.md).

## Testing

```bash
cd backend && npm test                    # Jest, runs in band; each test file gets its own throwaway database
cd backend && npx jest tests/unit/rbac-middleware.test.js --runInBand   # one file
cd ai && .venv/bin/python -m pytest -q    # AI service
cd frontend && npm test && npm run lint
```

MongoDB and Redis must be running for backend tests. They never touch your development database. Approach and conventions: [docs/development.md](docs/development.md).

## Documentation

Everything lives in [`docs/`](docs/README.md):

- [Architecture](docs/architecture.md), [Modules](docs/modules.md), [Authentication](docs/authentication.md), [RBAC and multi-tenancy](docs/rbac-multi-tenancy.md), [API reference](docs/api-reference.md)
- [Development guide](docs/development.md), [Deployment preparation](docs/deployment.md), [Project status](docs/project-status.md)
- Module deep dives: [assets](docs/modules/assets.md), [analytics](docs/modules/analytics.md), [calendar](docs/modules/calendar.md), [notifications](docs/modules/notifications.md)
- AI: [overview](docs/ai/ai-overview.md), [operations](docs/ai/ai-operations.md), [service contract](docs/ai/ai-service-contract.md)
