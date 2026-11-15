# Modules

One section per core module: purpose, features, API, data, permissions, workflows and dependencies. Exact request/response shapes are in [api-reference.md](api-reference.md) (older modules) and the module deep dives linked below. Status per module is in [project-status.md](project-status.md).

Conventions that apply to every module: routes need `authenticate` and, for tenant data, `requireOrgAccess`; every query is scoped by `organization`; no-access and cross-organization both return 404; success responses are `{ success: true, ... }`; errors are `{ success: false, message, code }`.

Roles: `super-admin`, `org-admin`, `admin`, `hr`, `manager`, `employee`, `guest`. `org-admin` and `admin` hold every permission; the only difference is that just an `org-admin` can grant the `admin` role.

---

## 1. Authentication and RBAC
- **Purpose:** identity, sessions and authorization. **Detail:** [authentication.md](authentication.md), [rbac-multi-tenancy.md](rbac-multi-tenancy.md).
- **API (`/api/v1/auth`):** `csrf-token`, `register`, `verify-email`, `resend-otp`, `login`, `refresh`, `logout`, `logout-all`, `GET me`, `PATCH me` (own first name, last name, skills; unknown fields such as role or email are rejected), `POST change-password` (needs the current password, counts failures toward the lockout, then signs the account out on every device), `me/status` (presence), `sessions` (list, revoke), `forgot-password`, `reset-password`.
- **Frontend:** `app/dashboard/settings` (profile and password forms in `features/account`).
- **Data:** `User`, `Session`, `RefreshToken`, `AuditLog`.
- **Permissions:** `constants/permissions.js` and `rolePermissions.js` (mirrored in `frontend/src/constants/permissions.js`). Resource-level rules live in `utils/*Access.js`.
- **Workflow:** register, verify email OTP, log in, create or join an organization (onboarding), then work. Blocking a person (`orgBlocked`) removes organization access but not login, so a person can later belong to another organization.

## 2. Organizations and onboarding
- **API:** `GET /organizations/me`, `POST /organizations` (create; the creator becomes `org-admin`), `PATCH /organizations/me` (**owner / `org-admin` only**: name, logo URL, default time zone; plan, limits, flags and slug stay platform-only), `GET /organizations/me/usage` (`org-admin`, `admin`: seats, pending invitations and storage against the plan limits); invitations at `/invitations` (list, invite, resend, revoke: `org-admin` and `admin` only; `accept` is public with a token; `accept-existing` for a logged-in user); platform administration at `/platform/organizations` (`super-admin` only: list, get, plan, **limits**, suspend, reactivate, feature flags); `GET /audit-logs` (`org-admin`, `admin`).
- **Data:** `Organization` (plan, limits, featureFlags, settings, suspension), `Invitation`.
- **Plan limits (enforced):** `Organization.limits` `{ seats, storageGB, aiCredits }` is the only plan configuration there is (there is no plan-to-limits table; the schema defaults are 5 seats, 1 GB, 0 credits and a super-admin changes them per organization with `PATCH /platform/organizations/:id/limits`). Everything goes through `services/planLimits.service.js`:
  - **Seats:** a member is an active, not blocked account. Inviting needs `members + pending invitations + 1 <= seats` (`SEAT_LIMIT_REACHED`, 403); accepting an invitation needs `members + 1 <= seats`.
  - **Storage:** Document versions plus project resources are summed; an upload, a new version or a version restore that would exceed `storageGB` is refused (`STORAGE_LIMIT_REACHED`, 413). Task attachments are not counted.
  - **AI credits:** no credit unit exists in the product (AI is metered in tokens), so the conversion is configuration: `AI_TOKENS_PER_CREDIT`. Unset (the default) means not enforced. When set, a positive `aiCredits` caps the organization's monthly AI tokens at `aiCredits * AI_TOKENS_PER_CREDIT`, never above its own quota; `aiCredits = 0` means not capped by the plan.
  - A missing, zero or non-numeric seats or storage value means unlimited. Limits only stop **new** consumption; existing members and files are never removed. `featureFlags` are still stored but not enforced.
- **Frontend:** `app/onboarding/*`, `features/organization`, `features/invitations`, `features/platform` (super-admin dashboard).

## 3. Dashboards
- **Purpose:** role-specific landing pages (`components/dashboard/views`): org admin, HR, manager, employee, guest, super admin.
- **Data:** KPI strips, trends, workload and project progress come from `/analytics/overview` and `/analytics/me`. Meetings and documents cards read the Meetings and Documents APIs. Cards that still carry a *Preview* badge use sample data: announcements, birthdays, onboarding status, recently joined, team snapshot, security snapshot, resource usage, AI insights and similar. They are listed in [project-status.md](project-status.md).

## 4. Projects
- **API (`/projects`):** list, create (`CREATE_PROJECT`), get, update, delete (`DELETE_PROJECT`), archive/restore, transfer ownership, favorite, activity, members (candidates, add, change role, remove), resources (upload, list, download, delete).
- **Data:** `Project` (owner, `members[{user, role}]`, visibility Private/Team/Organization, status Planning, Active, On Hold, Completed, Archived, optional `team`), `ProjectResource`.
- **Rules:** `utils/projectAccess.js`, `canDeleteProject.js`. Owner and members are the source of truth for access. Status changes follow a fixed transition table.
- **Depends on:** Teams (team-visibility), People (members), Tasks and Meetings (children), Notifications (member and ownership events), Analytics.

## 5. Tasks
- **API:** project-scoped `/projects/:projectId/tasks` (list, create, get, update, delete, archive/unarchive, submit for review, review, activity, attachments); the cross-project "My Tasks" list at `GET /tasks`.
- **Data:** `Task` (assignees, status Todo, In Progress, In Review, Completed, Cancelled, priority, Public/Private visibility, due date as a floating `YYYY-MM-DD`, `submissions[]`, `reviews[]`, attachments, `completedAt`).
- **Workflow:** assign, work, **submit for review** (creates a submission, status becomes In Review), reviewer replies (Approved / Changes requested), manager completes manually. Approval does not auto-complete.
- **Rules:** `utils/taskAccess.js`, `canEditTask.js`. "My Tasks" only shows Public tasks of projects the person belongs to plus their own. Regression test: `tests/integration/task-security.test.js`.

## 6. People
- **API (`/people`):** directory list and detail (`VIEW_PEOPLE`), update, force password reset, remove (`MANAGE_USERS`, further limited by `canManageUsers` and role).
- **Rules:** `utils/peopleAccess.js`. Managers see their own team, guests see public fields only. Role changes and org-blocking are `org-admin`/`admin` only; self-targeting is rejected.
- **Frontend:** `app/dashboard/people` with a person detail dialog. Inviting people is available to `org-admin`/`admin` (HR can manage people but the invitations API is restricted to admins).

## 7. Teams
- **API (`/teams`):** list, `me`, get, create, update, delete, add and remove members, set manager (lead).
- **Data:** `Team` (`lead`, `members[]`). **Rules:** `utils/teamAccess.js`. A manager is a team lead, not an organization-wide team administrator. Create and update are `org-admin`, `admin` and `hr`.
- **Frontend:** `app/dashboard/teams` (manage), `app/dashboard/my-team`.

## 8. Meetings and LiveKit
- **API:** project-scoped `/projects/:projectId/meetings` (list, schedule, instant, get, update, cancel, end, add/remove participants, kick from the room, join token, activity) and `/projects/:projectId/meeting-requests` (create, list, approve, reject, schedule); the cross-project `GET /meetings`; `POST /livekit/webhook` (signature verified, disabled unless `LIVEKIT_WEBHOOK_ENABLED`).
- **Data:** `Meeting` (participants with Host/other roles, status Scheduled, Active, Ended, Cancelled), `MeetingRequest`.
- **Rules:** `utils/meetingAccess.js`. A background cleanup ends rooms left empty and cancels scheduled meetings nobody joined. Video needs `LIVEKIT_*`; without it meetings still schedule but rooms cannot be joined.
- **Depends on:** Projects (members), Calendar (read-only source), Notifications (invites, cancellations, reminders).
- **Frontend:** `app/dashboard/meetings`, project meeting pages, `app/meeting-room/[projectId]/[meetingId]`.

## 9. Documents
- **API (`/documents`):** list, upload, get, update, move, delete, restore, permanent delete (admins), download, activity, shares, versions (list, upload, download, restore), folders (list, create, update, delete, restore, permanent delete), trash.
- **Data:** `Document`, `DocumentFolder`, `DocumentVersion`. **Rules:** `utils/documentAccess.js`, `fileValidation.js`. Visibility private, team, project, organization. Guests only see explicitly shared items. Retention auto-purge, public links and folder-level ACLs are deliberately not built.
- **Depends on:** Projects and Teams (visibility), Notifications (shares, versions), AI (ingestion hooks after changes).
- **Frontend:** `features/documents`, `app/dashboard/documents` and `.../trash`. **Tests:** `documents-flow`, `document-access`, `file-validation`.

## 10. Calendar
- **Detail:** [modules/calendar.md](modules/calendar.md). **API (`/calendar`):** unified list, preferences, event create/get/update/delete, RSVP.
- **Rules:** only standalone events are stored; meetings, tasks and project dates are read from their own collections. Default timezone is IST (user, then organization, then IST). Recurrence is expanded on demand. Reminders use the notification system.

## 11. Notifications
- **Detail:** [modules/notifications.md](modules/notifications.md). **API (`/notifications`):** list, live `stream` (SSE), unread counts, preferences, mark read, read-all, dismiss.
- **Rules:** only `notificationEvents.js` creates notifications; each event has a deterministic dedupe key. Blocked or removed people receive a durable email only. Event coverage: projects, tasks, meetings and requests, teams, role/access changes, calendar, documents, assets, AI.

## 12. Assets
- **Detail:** [modules/assets.md](modules/assets.md). **API (`/assets`):** inventory, summary, export, assignments, maintenance, catalog (categories, vendors), per-asset lifecycle actions (assign, transfer, return, reserve, retire, dispose, lost, found), documents, report issue.
- **Rules:** `AssetAssignment` rows are the source of truth; status changes only through named actions; license keys are pointers, never secrets.

## 13. Goals
- **Status: planned, not built.** There is no model, no API and no real UI. `app/dashboard/goals` and the project Goals tab show a "coming soon" page, and the dashboards' assigned-goals card is sample data. It is a separate future module; nothing else depends on it.

## 14. Reports and analytics
- **Detail:** [modules/analytics.md](modules/analytics.md). **API (`/analytics`):** `overview`, `me`, `tasks`, `projects`, `people`, `teams`, `meetings`, `assets`, `reports/:type` and `reports/:type/export` (CSV), `platform` (`super-admin`).
- **Scope:** org-admin/admin organization-wide, HR aggregate counts only, manager led teams, employee self, guest none, super-admin platform only. Reports and CSV share the same compute functions as the dashboards.
- **Frontend:** `app/dashboard/analytics`, `app/dashboard/reports`, `app/dashboard/projects/[projectId]/analytics`.

## 15. AI Studio and AI integration
- **Detail:** [ai/ai-overview.md](ai/ai-overview.md), [ai/ai-operations.md](ai/ai-operations.md), [ai/ai-service-contract.md](ai/ai-service-contract.md).
- **API (`/ai`):** `ask`, conversations (CRUD, messages), `status`, usage (me, organization), organization settings and disclosure (`MANAGE_AI`), knowledge ingestion and embedding administration (`MANAGE_AI_KNOWLEDGE`), super-admin platform status, usage, embedding migration and the live-tools kill switch.
- **Rules:** off per organization until an admin accepts the disclosure; guests and super-admin never get tenant AI; private documents are owner-only for AI; live workspace tools are a second, separate switch and are off by default.
- **Admin UI:** `app/dashboard/settings/ai` (`MANAGE_AI`): turn AI on after reading and accepting the disclosure, turn it off, view the accepted version, set the per-user daily and organization monthly token limits. The live-organization-data switch is deliberately **not** offered there and stays off. Knowledge ingestion status is still API-only.
- **Frontend:** `features/ai`, `app/dashboard/ai-studio`.
