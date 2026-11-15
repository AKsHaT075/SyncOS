# Project status and audit report

Result of the project-wide audit run on 2026-11-14, updated the same day after the follow-up decisions (profile and password change, organization editing, AI settings screen, enforced plan limits, cleanup, browser check). It is based on static inspection of routes, permissions, models, services, navigation and dashboards, on the existing test suites (not re-run in full, by design), and on a small set of focused checks listed at the end. It is **not** a line-by-line review of every file. The changed screens were inspected in a real browser (section 5).

Statuses: **Complete**, **Partially Complete**, **Incomplete**, **Needs Decision**.

## 1. Overall

The core workspace works end to end for projects, tasks, people, teams, meetings, documents, calendar, notifications, assets, analytics and reports; users can edit their profile and change their password; the organization owner can edit organization details; plan limits (seats, storage, optionally AI credits) are enforced; org admins have an AI settings screen; and the AI subsystem is built but intentionally dormant. Nothing is deployed. **Goals is a planned module that is not built.** Remaining gaps: preview-only dashboard cards, no admin screen for knowledge ingestion status, and scaling limits that matter only for multi-instance deployment ([deployment.md](deployment.md)).

## 2. Module status

| # | Module | Status | Evidence and notes |
|---|---|---|---|
| 1 | Authentication and RBAC | Complete | Login, OTP, refresh rotation, CSRF, sessions, lockout, seven roles and layered checks (unit tests `rbac-middleware`, `project-access`, `team-access`, `people-access`; integration `onboarding-flow`, `presence`). **New:** `PATCH /auth/me` and `POST /auth/change-password` with a Settings UI (`account-org-limits` test; browser-checked). |
| 2 | Organizations and onboarding | Complete | Create/join, invitations, platform administration, audit log (`onboarding-flow`). **New:** owner-only `PATCH /organizations/me`, `GET /organizations/me/usage`, super-admin `PATCH /platform/organizations/:id/limits`, enforced seat/storage limits (`account-org-limits`). `featureFlags` are still stored but not enforced. |
| 3 | Dashboards | Partially Complete | Six role dashboards; KPI, trend, workload and project cards use real analytics; meetings, documents and plan-usage cards use real data (fixed in this audit; browser-checked). Cards still labelled *Preview* with sample data: announcements, upcoming birthdays, onboarding status, recently joined, team snapshot, security snapshot, resource usage, AI insights, health and growth cards, platform health and feature-flag cards, parts of the HR and guest views. |
| 4 | Projects | Complete | Full CRUD, members, roles, ownership transfer, archive, resources, activity. Project-level Goals tab is a placeholder. Thin integration coverage (access rules are unit-tested). |
| 5 | Tasks | Complete | CRUD, assignees, attachments, submit-for-review and review, archive, My Tasks; `task-security` regression test. |
| 6 | People | Complete | Directory, role change, block, remove, force reset, scoped visibility (`teams-people-flow`, `people-access`). Inviting is limited to `org-admin`/`admin` by the API; HR can manage people but not invite (see section 6). |
| 7 | Teams | Complete | CRUD, members, lead, My Team (`teams-people-flow`, `team-access`). |
| 8 | Meetings and LiveKit | Complete (not exercised live) | Schedule, instant, requests and approval, participants, kick, webhook, cleanup. No dedicated integration test and no live LiveKit check in this audit. |
| 9 | Documents | Complete | `documents-flow`, `document-access`, `file-validation`. |
| 10 | Calendar | Complete | `calendar-api`, `calendar-reminders`, `timezone`, `recurrence`. |
| 11 | Notifications | Complete | `notifications-api/events/stream`, `email-queue`, `notification-core`. |
| 12 | Assets | Complete | `assets-core`, `assets-lifecycle`, `asset-rules`. Attaching and removing documents requires update permission and document visibility (checked in `assetDocument.service.js`). |
| 13 | Goals | Incomplete (planned) | A planned future module: no model, API or real UI. The empty `Goal.js` placeholder was removed. The sidebar and project Goals tab show a "coming soon" page. |
| 14 | Reports | Complete | Share the analytics compute functions, CSV export (`analytics-api`). |
| 15 | Analytics | Complete | Scope rules per role, caching by scope hash (`analytics-api`, `analytics-core`, `analytics-indexes`). |
| 16 | AI Studio and AI integration | Complete (dormant) | Backend, Python service and AI Studio verified in earlier phases; live tools off by default. **New:** AI settings screen (`/dashboard/settings/ai`) over the existing settings and disclosure APIs: enable after accepting the disclosure, disable, usage limits; live-data switch intentionally not offered. Knowledge ingestion status is still API-only. |

## 3. Findings inventory

### Confirmed and fixed in this audit

| # | Sev | Finding | Fix |
|---|---|---|---|
| F1 | High | People page "Invite Teammate" linked to `/dashboard/people/invite`, which does not exist (404); the working invite dialog was only on the org-admin dashboard. | The button now opens the existing `InviteTeammateDialog`, shown only to `org-admin` and `admin`, which is what the API allows. |
| F2 | Medium | Sidebar "Goals" (`/dashboard/goals`), user-menu items (`/dashboard/settings/*`), "Settings" and the quick link "My Tasks" (`/dashboard/mytask`) all led to 404 pages. | Added `app/dashboard/goals` (honest placeholder) and `app/dashboard/settings` (read-only account and organization summary plus a link to notification preferences); quick link now goes to `/dashboard/tasks`; all settings entries point to the settings page. |
| F3 | Medium | Dashboard quick actions pointed at routes that do not exist (`tasks/new`, `teams/new`, `documents/upload`, `meetings/new`, `people/invitations`, `people/onboarding`). | Re-pointed to the existing list pages. |
| F4 | Medium | HR dashboard offered "Invite employee" and "Pending invites", which the API rejects for HR (403). | Replaced with actions HR can perform (people directory, teams, reports). |
| F5 | Medium | Manager, org admin and guest dashboards showed mock "Upcoming meetings" and "Latest documents". | New `components/dashboard/LiveWidgets.jsx` reads the Meetings and Documents APIs (already access-filtered by the server); the Preview badge is removed from those two cards. |
| F6 | Medium | No `.env.example` for backend or frontend, so a new developer could not tell which variables are required. | Added `backend/.env.example` and `frontend/.env.example` (names and safe placeholders only). |
| F7 | Low | Stale comment in `rolePermissions.js` claimed an admin may invite admins (the code and test say only `org-admin`). | Comment corrected. |
| F8 | Low | Documentation scattered across `backend/docs`, `ai/contracts`, `backend/postman`, root README; outdated references. | All documentation moved under `docs/`, references updated, new architecture, modules, development, deployment and status documents. |
| F9 | Medium | No way to edit one's own profile or change a password. | `PATCH /auth/me`, `POST /auth/change-password`, Settings forms (section 3 of [modules.md](modules.md)). |
| F10 | Medium | No way to edit organization details. | Owner-only `PATCH /organizations/me` (name, logo, default time zone) with a Settings form. |
| F11 | Medium | Plan limits were stored but never enforced. | `services/planLimits.service.js`: seats at invitation and acceptance, storage at upload, new version, restore and project resources, AI credits via `AI_TOKENS_PER_CREDIT`; super-admin endpoint to set limits; usage endpoint and cards. |
| F12 | Medium | An org admin could not turn AI on from the product. | AI settings screen. |
| F13 | Medium | The dashboard "Resource usage" and "Team" cards showed invented figures (50 GB, AI credits, 10 / 8 seats) that contradicted the real limits. | "Plan usage" card now reads real seats and storage; the sample team card no longer compares against seats. Dead mock data removed. |
| F14 | Low | Settings link cards and the AI warning rendered their icon above the text (card direction). | Fixed with `flex-row`. |
| F15 | Low | Two unreferenced preview files and the empty `Goal.js` model. | Deleted after confirming no references. |

### Confirmed, not fixed (decided or out of scope)

| # | Sev | Finding | Status |
|---|---|---|---|
| D1 | Info | **Goals** is not built. | Planned future module, not part of this release. Placeholder pages stay. |
| D2 | Medium | Rate limiters are per process; background jobs are not leader-elected. | Single-instance deployment, documented in [deployment.md](deployment.md). |
| D3 | Low | Cards marked Preview remain on several dashboards. | Honestly labelled; need endpoints that do not exist (announcements, birthdays, onboarding). |
| D4 | Low | No admin screen for knowledge ingestion status; the live-data switch is not offered in the AI screen. | Intentional: live tools stay dormant. |
| D5 | Low | No integration tests for the projects and meetings endpoints (access rules are unit-tested). | Recorded risk. |
| D6 | Low | Default limits (5 seats, 1 GB, 0 AI credits) apply to every organization that has no explicit value. | Set real limits per organization before onboarding tenants; existing organizations over a limit keep working but cannot grow. There is no plan-to-limits table (not invented). |
| D7 | Low | Task attachments are not counted toward storage; the AI credit unit needs `AI_TOKENS_PER_CREDIT`. | Documented in [modules.md](modules.md). |

### Uncertain

- HR cannot invite people (the invitations API requires `org-admin`/`admin`). This was confirmed as intended and left unchanged.
- Query efficiency under large data was not measured; the analytics and asset code has index tests, other modules were not profiled.

## 4. Security and RBAC findings

No cross-organization access or privilege-escalation path was found in the areas inspected. Specifically checked:

- Every tenant router applies `authenticate` and `requireOrgAccess`; permissions are enforced with `checkPermission` or service-level predicates; platform routes require `super-admin` and do not return tenant content; the LiveKit webhook is public by design but verifies LiveKit's signature and is disabled by default.
- Asset-document linking requires update permission plus visibility of the document (404 otherwise). Task and project routes without a route permission rely on membership checks in services, with the `task-security` regression test.
- Errors never include stack traces (`http-error-sanitization` test); cookies are HTTP-only and `Secure` in production; CSRF double-submit is active.
- Frontend permission checks only hide controls; the UI changes in this audit did not widen any access (the invite button is now narrower than before).

Residual items, all recorded above: per-process rate limits, unenforced plan limits, and the lack of a live (browser) re-verification of every role path in this pass.

## 5. Verification performed

- **Backend, focused:** new `tests/integration/account-org-limits.test.js` (9 tests: profile edit and rejected fields, password change with lockout path and session revocation, owner-only organization edit and tenant isolation, seat limit at invite and accept, unlimited when zero, storage limit, AI credit cap, platform limits validation); with the existing `documents-flow`, `onboarding-flow`, `teams-people-flow`, `ai-settings` suites (126 tests) and the RBAC, invitable-roles, AI permission and token unit tests (34) after the changes: all pass.
- **Frontend:** `eslint src` clean; `npm test` 40/40.
- **Real browser** (headless Chrome over CDP against an isolated backend and database, since removed): 51 checks across org admin, HR, employee and guest at 1280 px and 390 px: dashboards, People (invite dialog, HR has no invite button), Settings (profile, organization, usage, password change and re-login, role-based visibility), AI settings (banner, quota validation and save through the existing API), Goals placeholder, no horizontal overflow, no console errors. Two genuine defects were found and fixed (section 3, F13 and F14).
- **Not run, by design:** the full backend and AI suites. Existing results for unchanged code were reused.
- **Not verified:** enabling AI end to end from the new screen (needs the Python service and a Groq key; the screen was checked against an unconfigured server), and LiveKit.
