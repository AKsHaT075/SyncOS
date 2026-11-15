# Analytics & Reporting

Real, role-scoped analytics for every role, plus detailed reports and CSV export. Nothing is mocked: every number is aggregated from the existing collections (Task, Project, Meeting, Team, User, Asset*, AuditLog, Organization). No data is duplicated.

Code: `services/analytics/*` (one file per domain + `scope.js`, `cache.js`, `common.js`, `index.js`), `utils/analyticsRange.js`, `routes/analytics.routes.js` (`/api/v1/analytics`), `validations/analytics.validation.js`, `constants/analytics.constants.js`. Frontend: `features/analytics/*`, pages `app/dashboard/analytics` and `app/dashboard/reports`, real widgets in `components/dashboard/AnalyticsWidgets.jsx`.

## Who sees what
| Role | Scope kind | Data |
| --- | --- | --- |
| org-admin, admin (identical) | `organization` | Everything in the organization |
| hr | `aggregate` | Organization-wide **counts and workload** per person/team. Never task titles, project names, private task content or per-project/meeting rows. Built by dedicated aggregation; HR's project/task permissions are unchanged |
| manager | `team` | People in teams they lead (plus themselves), restricted to tasks/projects/meetings they can already see (same rules as `listTasks`/`canViewProject`). Plus personal analytics |
| employee | `self` | Only their own tasks, deadlines, projects, meetings, assets, activity (`GET /me`) |
| guest | `none` | 403 everywhere |
| super-admin | platform only | `GET /platform`: organization/user counts, growth, plan mix, sign-ins. No tenant content. 403 on tenant endpoints |

Permissions: `VIEW_ANALYTICS` (org-admin, admin, hr, manager) for organization/team views and reports; `VIEW_OWN_ANALYTICS` (employee, manager, org-admin, admin) for `/me`. Analytics never expands existing resource permissions: filters (`teamId`, `userId`, `projectId`) are validated against the caller's scope and out-of-scope values are a 404 (HR gets 403 for `projectId`).

## Endpoints (`/api/v1/analytics`)
`GET /overview` (role-aware) · `/me` · `/tasks` · `/projects` · `/people` · `/teams` · `/meetings` · `/assets` · `/reports/:type` (paginated: `page`, `limit`≤100) · `/reports/:type/export` (CSV) · `/platform` (super-admin). Query: `from`, `to` (YYYY-MM-DD), `teamId`, `userId`, `projectId`, `timezone`. Response envelope: `{ scope, range, filters, kpis, series, breakdowns, notes }`. **Overview, reports and CSV call the same `compute*` functions**, so numbers cannot differ between them.

## Dates and timezones
Timezone: request → user → organization (`settings.timezone`) → IST (the calendar rule). `from`/`to` are inclusive calendar days in that zone (default last 30 days, max 366). Timestamp fields (createdAt, completedAt, meeting start…) are bucketed with `$dateToString` in the zone: daily up to 92 days, monthly beyond. Task/project **due dates are floating date-only values**: "overdue" = due date < today's date in the zone, compared as UTC-midnight dates (due today is not overdue). Cancelled/Completed tasks are never overdue.

## Metric definitions
- **Task completion** counts `status = Completed`. Trends use `completedAt` (set on every transition into Completed, **cleared when reopened/cancelled**). Older completed tasks may have no `completedAt`: they count in totals but not in trends or average completion time (`completedWithoutDate` is reported). Nothing is back-filled.
- **Average completion time** = `completedAt − createdAt`, with sample size.
- **Project progress** = completed ÷ (tasks − cancelled). There is no stored progress. **Projects completed over time** comes from `project.status_changed → Completed` audit events (no project completion timestamp exists), so it is approximate. **Project duration** is planned (start → due) only.
- **Meetings**: planned length = `endTime − startTime`; **actual length** only from `meeting.started`/`meeting.ended` audit pairs (sample shown); attended = participant `joinedAt` set.
- **People/teams**: workload and participation counts only. No performance score. Team task figures count assignments (a task with two members of one team counts twice).
- **Assets**: reuses the role-scoped asset summary; maintenance spend and purchase value are per currency (never summed) and only for `VIEW_ASSET_REPORTS`.
- **Not available**: Goals (model is empty), actual project completion dates, time tracking, storage/AI usage.

## Safety and performance
- Scope is resolved once per request (`scope.js`) and applied inside every aggregation's `$match`. The task visibility rule mirrors `listTasks`; employees only ever match `assignees: me`.
- Every aggregation has `maxTimeMS`; ranges, people (2000), teams (200), projects (5000), top-N lists and report rows (5000) are capped. CSV cells neutralise spreadsheet formulas.
- **Cache**: in-process, 60 s, max 300 entries, off in tests. Key = organization + user + role + permissions + hash of the resolved scope (teams led, visible projects, people) + endpoint + filters + range + timezone. Any role/team/project-membership change changes the key.
- Indexes added : Task `{org,status,dueDate}`, `{org,completedAt}`, `{org,createdAt}`, `{org,assignees,status}`; Meeting `{org,startTime}`; AuditLog `{org,action,createdAt}`, `{action,createdAt}`; User `{org,createdAt}`; Organization `{createdAt}`.

## Related fixes made alongside
- `GET /tasks` ("my tasks") returned every Public task in the organization to non-admins; it now includes Public tasks only from projects the user belongs to. Regression test: `task-security.test.js`.
- `completedAt` rule above.

## Frontend
`/dashboard/analytics` (tabs by role, filters in the URL, print stylesheet), `/dashboard/reports` (table, pagination, CSV, print), project Analytics tab, and the six role dashboards now use real data. Cards that still have no real source keep a visible "Preview" badge (the badge previously did not render; `DashboardCardHeader` now shows it).

## Tests
`tests/unit/analytics-core.test.js`, `tests/integration/analytics-api.test.js` (access matrix, per-role scope, HR privacy, manager limits, isolation, meetings, assets, reports/CSV, platform, cache), `tests/integration/task-security.test.js`.

## Known limitations
Cache is per process. Month granularity for ranges over 92 days. Manager scope truncates at 5000 visible projects (flagged in `scope.truncated`). Overdue *history* cannot be reconstructed (no status snapshots), so the overdue chart shows currently-open overdue tasks by due date. Historical gaps (tasks completed before `completedAt` was reliable, projects completed before audit events) are labelled in the UI notes.
