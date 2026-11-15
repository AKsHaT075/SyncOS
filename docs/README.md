# Sync OS documentation

Everything lives under `docs/`. The only other documents are the short READMEs next to the code: [README.md](../README.md), [backend](../backend/README.md), [frontend](../frontend/README.md) and [ai](../ai/README.md).

```
docs/
├── architecture.md        system overview: frontend, backend, data model, jobs, files, AI
├── development.md         local setup, environment variables, conventions, testing, troubleshooting
├── deployment.md          infrastructure, configuration, security prerequisites, backups, rollback
├── project-status.md      per-module status, audit findings, open decisions
├── api/                   request/response reference and Postman testing guide
├── security/              authentication and RBAC / multi-tenancy
├── modules/               one page per module (README.md is the overview)
└── ai/                    AI service: overview, operations, Node-to-Python wire contract
```

| Folder | Documents |
|---|---|
| Overview | [architecture](architecture.md), [development](development.md), [deployment](deployment.md), [project status](project-status.md) |
| [api/](api/) | [api-reference](api/api-reference.md), [postman-testing](api/postman-testing.md) |
| [security/](security/) | [authentication](security/authentication.md), [rbac-multi-tenancy](security/rbac-multi-tenancy.md) |
| [modules/](modules/README.md) | [overview of every module](modules/README.md), [calendar](modules/calendar.md), [notifications](modules/notifications.md), [assets](modules/assets.md), [analytics](modules/analytics.md) |
| [ai/](ai/) | [ai-overview](ai/ai-overview.md), [ai-operations](ai/ai-operations.md), [ai-service-contract](ai/ai-service-contract.md) |

Test fixtures shared by the Node and Python suites stay in `ai/contracts/*.json`.
