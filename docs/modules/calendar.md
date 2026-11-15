# Calendar & scheduling — architecture

One calendar view over four sources. **Nothing is copied**: only standalone events live in the new
`CalendarEvent` collection; meetings, tasks and project deadlines are read from their own collections at
request time, under each module's own access rules.

| Item | Source of truth | Editable in the calendar? | Dates |
|---|---|---|---|
| Event (personal / general / team / organization) | `CalendarEvent` | yes | timed (UTC instants) or all-day (floating dates) |
| Meeting | `Meeting` | no — links to the meeting page; "Join now" when permitted | timed |
| Task deadline | `Task.dueDate` | no — links to the task | all-day, floating |
| Project deadline | `Project.dueDate` | no — links to the project | all-day, floating |

## API (`/api/v1/calendar`, all require sign-in and a non-blocked organization member)

| Method & path | Purpose |
|---|---|
| `GET /calendar?fromDate&toDate&tz&scope&teamId&projectId&assigneeId&types&status&q&includeCancelled` | Unified items for the visible days. `fromDate`/`toDate` are inclusive calendar days in `tz`; range ≤ 100 days |
| `POST /calendar/events` (`CREATE_EVENT`) | Create |
| `GET /calendar/events/:id` | Event detail (attendees, recurrence, reminders, local wall-clock values for editing) |
| `PATCH /calendar/events/:id` (`CREATE_EVENT`) | Edit; `scope: series \| occurrence` + `occurrenceStart` |
| `DELETE /calendar/events/:id?scope=&occurrenceStart=` | Delete a series (soft) or cancel one occurrence |
| `POST /calendar/events/:id/rsvp` | Attendee response (not available to guests) |
| `GET` / `PUT /calendar/preferences` | Timezone, week start, default view, hidden legend categories |

Item ids are stable: `event:<id>` (one-off), `event:<id>:<originalStartMs>` (recurring occurrence),
`meeting:<id>`, `task:<id>`, `project:<id>`.

## Scopes

* **Personal** — your events (and ones you're invited to, plus team/org/project events you can see), meetings you host
  or attend, tasks assigned to you, deadlines of projects you belong to.
* **Team** — requires being on the team, or org-admin/admin/HR. Team events, general events of the team's projects,
  meetings of the team's projects or with team members, task deadlines of the team's projects, their project deadlines.
* **Organization** — organization events, meetings you can access, project deadlines you can access. Individual task
  deadlines are left out unless `types` asks for them.

## Access rules (`utils/calendarAccess.js`)

* **View**: owner/attendee always; personal events — only those two (not even admins); team — team members + lead and
  team admins (org-admin/admin/HR); project events — members of the project; organization — everyone except guests;
  org-admin/admin see everything except personal events. **Guests**: only events they own/are invited to, or of a project
  they are an explicit member of; read-only.
* **Create/manage**: personal & general — the owner (project-linked: the project's owner/manager or an org admin);
  **team — org-admin/admin/HR, or a manager only for a team they currently lead** (authority follows current
  leadership, not who created the event); **organization — org-admin/admin/HR only**.
* Type, team, project and visibility are fixed at creation (changing them would be a privilege change).
* Events the actor can't see are `404`, not `403`. Cross-organization ids are always `404`.

## Time and timezones

* All instants are stored in **UTC**. Each timed event also stores its **IANA timezone** (the zone it was authored in).
* Clients send **wall-clock** strings (`2026-03-10T09:00`) plus the zone, or an absolute instant (`…Z`); the server does
  the single conversion (`utils/timezone.js`, `Intl`-based, no dependency) and returns UTC plus the wall-clock values in
  the event's zone for editing — so re-saving never shifts a time.
* DST: an ambiguous wall time (clocks fall back) resolves to the **first** occurrence; a nonexistent one (spring forward)
  moves **forward** by the gap (02:30 → 03:30). Both are covered by tests.
* The viewer's zone resolves as: explicit `tz` → saved calendar preference → `Organization.settings.timezone` →
  **IST (`Asia/Kolkata`)**. Everything on screen is shown in that zone; each event also shows the zone it was created in.
* **All-day items and task/project due dates are floating dates** (`YYYY-MM-DD`, stored at UTC midnight, never shifted).
  They are read by UTC date parts, so they appear on the same day in every timezone. (Other pages that format task
  dates with the browser's local zone may show the previous day west of UTC — not touched here.)

## Recurrence

* Stored as a **rule**, never as generated rows: `freq` daily/weekly/monthly, `interval` 1–99, weekly `byWeekday`,
  monthly by date (clamped to the month's last day) or by Nth weekday (1–4 or last), and an `until` date **or** a `count`
  (≤ 1000). No yearly rule in v1.
* **Expansion is bounded**: only the requested window is expanded (rules without a `count` fast-forward straight to the
  window), with an iteration cap and a per-request occurrence cap. Expansion runs on the **wall clock in the event's
  timezone** and converts each occurrence to UTC, so "every Monday 09:00" stays 09:00 local across DST; the duration
  is held constant in absolute time.
* **Occurrence identity** is `originalStart` and never changes. Editing/deleting one occurrence writes an **exception**
  (`{originalStart, cancelled | overrides}`, max 500). A moved occurrence is shown in its new window even if its
  original slot is outside it. The server verifies an `occurrenceStart` is a genuine occurrence before accepting it.
* Editing the **series** keeps exceptions when only text changes; changing the schedule (start/end/zone/rule) clears
  them. The first date must itself match the rule (`INVALID_RECURRENCE` otherwise). "This and following" is not in v1.
* Meetings are never recurring (the Meeting model doesn't support it).

## Reminders and notifications

* Event reminders: 0–5 per event, any lead time from 1 minute to 7 days (presets 5/15/30/60 min, 1 day), each optionally
  **also emailed**. Delivered through the existing notification system (`calendar.reminder`, category `calendar`);
  email is sent only if the reminder asked for it **and** the user allows calendar email.
* A per-minute job (`calendarReminders.js`, locked across instances) expands upcoming occurrences. The dedupe key is
  `(occurrence anchor, offset, recipient)`: repeated ticks never duplicate; a moved/rescheduled occurrence has a new anchor and
  reminds again for its new time. Deleted/cancelled events and cancelled occurrences are never reminded; declined
  attendees and blocked users are skipped. A reminder more than 15 min late is dropped rather than replayed.
  All-day events measure from local midnight in the event's timezone.
* Audience: owner + attendees (+ the whole team roster for team events). Organization events remind only the owner and
  invitees, to avoid mass notifications.
* **Meetings keep their existing 15-minute in-app reminder** (`meeting.reminder`); no calendar reminder is created for them.
* Other notifications: `calendar.event_invited`, `calendar.event_updated` (time/title/location/link changes only),
  `calendar.event_cancelled` (series or one occurrence; never links).

## Indexes

`CalendarEvent`: `{organization, deletedAt, start, end}`, `{organization, deletedAt, recurrence.until, start}`,
`{owner}`, `{attendees.user}`, `{team}`, `{project}`, plus a partial index for events that have reminders.
Added to existing models: `Task {organization, dueDate}`, `Project {organization, dueDate}`.

## Known limitations

* Task/meeting items are read-only here by design; editing happens in their modules.
* Organization events don't remind the whole organization, only the owner and invitees.
* Per-occurrence RSVP and per-occurrence attendee/reminder changes aren't supported (whole series only).
* Browser-side behaviour (drag/resizing, keyboard navigation of the grid) is basic: click to open, click an empty slot to create.
