# Sync OS documentation

Start here. Everything is under `docs/`; the only other documents are short READMEs next to the code (`README.md`, `backend/README.md`, `frontend/README.md`, `ai/README.md`).

| Document | What it covers |
|---|---|
| [../README.md](../README.md) | Project introduction, features, stack, setup, running, testing |
| [architecture.md](architecture.md) | Frontend, backend, data model, multi-tenancy, Redis and jobs, files, LiveKit, AI at a glance |
| [modules.md](modules.md) | Every core module: purpose, API, data, permissions, workflows, dependencies |
| [authentication.md](authentication.md) | Tokens, cookies, sessions, OTP, CSRF, lockout, rate limiting |
| [rbac-multi-tenancy.md](rbac-multi-tenancy.md) | Organizations, roles, permissions, isolation rules (written early; modules.md and the code are authoritative for later modules) |
| [api-reference.md](api-reference.md) | Request and response shapes for the original auth, organization, people, team and project APIs |
| [api-testing-postman.md](api-testing-postman.md) | Manual testing with the Postman collection in `backend/postman/` |
| [development.md](development.md) | Local setup, environment variables, conventions, testing approach, troubleshooting |
| [deployment.md](deployment.md) | Infrastructure assumptions, configuration, security prerequisites, backups, monitoring, rollback |
| [project-status.md](project-status.md) | Per-module status, audit findings, fixes, open decisions |
| [modules/calendar.md](modules/calendar.md) | Calendar design, timezone, recurrence, reminders |
| [modules/notifications.md](modules/notifications.md) | Notification design, delivery, retention, operations |
| [modules/assets.md](modules/assets.md) | Asset lifecycle, roles, integrity, operations |
| [modules/analytics.md](modules/analytics.md) | Metric definitions, scopes, caching, limits |
| [ai/ai-overview.md](ai/ai-overview.md) | AI design by phase: settings, ingestion, embeddings, RAG, conversations, live tools |
| [ai/ai-operations.md](ai/ai-operations.md) | AI setup, configuration, permissions, kill switch, rollout and rollback, limitations |
| [ai/ai-service-contract.md](ai/ai-service-contract.md) | Wire contract between Node and the Python AI service |

Test fixtures shared by the Node and Python suites stay in `ai/contracts/*.json`.
