# Assets Management

IT/office equipment and software licenses: inventory, categories, vendors, assignment / transfer / return with immutable history, lifecycle, maintenance (including employee requests), warranty and license alerts, linked documents, dashboard and CSV export.

Code: `models/Asset*`, `services/asset*.js`, `utils/assetAccess.js`, `constants/asset.constants.js`, `routes/asset.routes.js` (mounted at `/api/v1/assets`), `validations/asset.validation.js`. Frontend: `frontend/src/features/assets/*`, pages under `app/dashboard/assets/*` and `app/dashboard/my-assets`.

## Data model
- **Asset** – hardware or software (`kind`). Org-scoped `assetId` (`AST-000001`, from `AssetCounter`), optional `assetTag` / `serialNumber` (unique per organization only when set). Denormalised holder fields (`assignedUser`, `assignedTeam`, `currentAssignment`) are a cache of the assignments. Archive = soft delete (`deletedAt`).
- **AssetAssignment** – the source of truth for who holds what. Rows are never deleted; they are `ACTIVE`, `CLOSED` (returned / transferred / lost / reconciled) or `VOID` (an attempt that never took effect, hidden from history).
- **AssetMaintenance**, **AssetCategory** (9 defaults seeded per organization on first read), **AssetVendor**, **AssetDocument** (link to a `Document`; files are never copied).

## Roles
| Role | Can |
| --- | --- |
| org-admin / admin | everything (inventory CRUD, lifecycle, maintenance, categories, vendors, licenses incl. key reference, reports) |
| HR | view everything; assign / transfer / return for anyone; vendors; reports/export. Not create/edit/delete inventory |
| manager | see assets held by people / owned by teams they **currently lead**, plus the assignable pool; assign / transfer / return only within their people and teams; report issues |
| employee | see only assets they hold (directly, via a team, or a license seat); report an issue |
| guest | nothing |

Scope is evaluated live (`utils/assetAccess.js`). Cross-org and no-access both return 404. The legacy `MANAGE_ASSETS` permission is kept; `canAssignAssets.js` is untouched.

## Lifecycle
`AVAILABLE ⇄ RESERVED`, `→ ASSIGNED`, `→ UNDER_MAINTENANCE`, `→ LOST`, `→ RETIRED → DISPOSED` (table in `constants/asset.constants.js`). Status changes **only** through named actions (assign / transfer / return / reserve / release / retire / dispose / lost / found / start-complete-cancel maintenance), never a plain `PATCH`. Each uses one conditional atomic update, so a concurrent change yields 409, never a silent override. A disposed asset is read-only; a held asset (or a license with seats in use) must be returned before it can be retired or archived.

## Integrity without transactions (standalone MongoDB)
- Unique partial indexes: one `ACTIVE` exclusive assignment per asset; one `ACTIVE` seat per (asset, person); one `IN_PROGRESS` maintenance job per asset.
- Ordering: **assign** = write assignment → claim asset (void the assignment if the claim loses); **return** = close assignment → release asset; **transfer** = close old → open new (restoring the old holder on failure) → re-point asset.
- `repairAsset` / `reconcileAssignments` make the asset follow its assignments (and recompute seat counters). They run hourly from the asset job and after any failed step.
- Software seats: a per-person `ACTIVE` assignment plus a guarded `$inc` of `license.allocatedSeats` with an `$expr` seats check.

## Licenses
`license.keyReference` is a pointer to where the key is kept (vault item, ticket) — never the secret. It is returned only to holders of `MANAGE_ASSET_LICENSES`; everyone else gets `hasKeyReference`. It is excluded from audit metadata, the activity feed, notifications and CSV export. One seat per person; no team seats; expired licenses can't take new seats; seats can't be reduced below what is in use.

## Dates and money
Purchase / warranty / license / maintenance dates are date-only (`YYYY-MM-DD`, stored at UTC midnight, displayed as the same calendar day). Default currency INR, each asset has its own currency, and totals are reported **per currency** — different currencies are never added together. Invalid calendar dates (`2026-02-30`) are rejected. The default timezone for the app remains IST.

## Maintenance
Employees holding an asset (and anyone with maintenance rights) can `POST /:id/report-issue` → `REQUESTED`. Admins approve (→ `SCHEDULED`, with a date) or decline (with a reason). `SCHEDULED → IN_PROGRESS → COMPLETED / CANCELLED`. Starting puts the asset `UNDER_MAINTENANCE` (remembering ASSIGNED vs AVAILABLE); completing / cancelling restores it, records cost, next-due date and condition. Costs are visible only to maintenance managers and report viewers.

## Notifications (category `asset`)
`assigned`, `transferred` / `transferred_away`, `return_requested`, `returned`, `lost`, `maintenance_requested` / `scheduled` / `declined` / `completed`, `maintenance_overdue`, `warranty_expiring`, `license_expiring`, `former_member_holds`. Only `assigned`, `return_requested`, `warranty_expiring` and `license_expiring` may email. Titles are generic; names appear only in the message. Failures are isolated: a notification outage never fails an action.

Alerts (`assetJobs.js`, run hourly under the existing Redis lock) fire at 30 / 7 / 1 days before warranty or license expiry / renewal. The smallest covering threshold is the dedupe key, so an asset moves 30 → 7 → 1 and re-running the job never duplicates. Retired / disposed / archived assets don't alert. Overdue scheduled maintenance alerts once.

## People and teams
Blocking or removing someone **keeps** their assignments and history; admins and HR are notified (`asset.former_member_holds`) and the person appears under *Assignments → Offboarding* (`GET /offboarding`, org-wide roles only) until the equipment is returned. History rows show a "no longer in the organization" marker.

## Documents
`POST /:id/documents` links an existing Document (kinds: image, invoice, warranty, manual, assignment_agreement, maintenance_report, other). The actor must be able to see the document; viewers see `ok`, `restricted` (placeholder only) or `unavailable` (deleted). Linking never grants access. `image` links must be image documents and set the asset photo. Unlinking never deletes the file.

## Reports
`GET /summary` aggregates live data scoped to what the viewer may see: totals, by status / category / team / holder, per-currency purchase value (only with `VIEW_ASSET_REPORTS`), license seat usage, expiring warranties and licenses, upcoming maintenance, recent assignments. `GET /export` streams CSV (formula-injection neutralised, license keys never included, capped at 5000 rows).

## Endpoints (`/api/v1/assets`)
`GET /` list (search, status, category, kind, team, holder, location, warranty, purchase dates, sort, pagination) · `POST /` · `GET /mine` · `GET /summary` · `GET /export` · `GET /options` · `GET /offboarding` · `GET /assignments` · `GET /maintenance` · `GET|POST /categories` (+`PATCH /categories/:id`, `POST /categories/:id/archive {moveTo}`) · `GET|POST /vendors` (+`PATCH|DELETE /vendors/:id`) · `GET|PATCH|DELETE /:id` · `POST /:id/restore|assign|transfer|return|request-return|reserve|release|retire|dispose|lost|found|report-issue` · `GET /:id/assignments|activity` · `GET|POST /:id/maintenance` (+`PATCH /:id/maintenance/:mid`, `POST …/approve|decline|start|complete|cancel`) · `GET|POST /:id/documents`, `DELETE /:id/documents/:linkId`.

## Tests
`tests/unit/asset-rules.test.js`, `tests/integration/assets-core.test.js` (CRUD, validation, scope, categories, vendors, licenses, documents, reports, isolation), `tests/integration/assets-lifecycle.test.js` (assign / transfer / return, concurrency, repair, maintenance, alerts, people integration).

## Known limitations
No Calendar integration (maintenance / warranty dates are not shown on the calendar). No barcode / QR scanning, depreciation, purchase-order workflow or bulk import. License seats are per person only. Concurrency safety relies on atomic single-document updates plus reconciliation, because the deployment uses standalone MongoDB; moving to a replica set would allow real transactions.
