import { PERMISSIONS } from "@/constants/permissions";

/**
 * Where each notification type "lives" in the app. A section badge is the number of unread notifications whose
 * type belongs to that section; opening the section clears them. Types not listed here (security, personal
 * role changes, "transferred away" notices…) only show in the notification bell.
 *
 * `can(permission)` lets one type land in different places for different people: e.g. a maintenance update goes
 * to "Maintenance" for the people who run it, and to "My assets" for the person who reported the problem.
 */
const ASSETS = "/dashboard/assets";

const PREFIX_SECTIONS = {
  task: "/dashboard/tasks",
  project: "/dashboard/projects",
  meeting: "/dashboard/meetings",
  meeting_request: "/dashboard/meetings",
  team: "/dashboard/my-team",
  document: "/dashboard/documents",
  calendar: "/dashboard/calendar",
};

export function sectionForType(type, can) {
  const [prefix] = String(type).split(".");
  if (prefix !== "asset") return PREFIX_SECTIONS[prefix] ?? null;

  const runsMaintenance = can(PERMISSIONS.MANAGE_ASSET_MAINTENANCE);
  switch (type) {
    case "asset.assigned":
    case "asset.transferred":
    case "asset.return_requested":
      return "/dashboard/my-assets";
    case "asset.maintenance_requested":
    case "asset.maintenance_overdue":
      return `${ASSETS}/maintenance`;
    case "asset.maintenance_scheduled":
    case "asset.maintenance_declined":
    case "asset.maintenance_completed":
      return runsMaintenance ? `${ASSETS}/maintenance` : "/dashboard/my-assets";
    case "asset.returned":
    case "asset.former_member_holds":
      return `${ASSETS}/assignments`;
    case "asset.lost":
    case "asset.warranty_expiring":
    case "asset.license_expiring":
      return `${ASSETS}/inventory`;
    default:
      return null;
  }
}

/** Unread total for a nav href. `exact` = only that page (a tab); otherwise the page and everything under it. */
export function countForHref(counts, href, can, { exact = false } = {}) {
  let total = 0;
  for (const [type, count] of Object.entries(counts ?? {})) {
    const section = sectionForType(type, can);
    if (section && (section === href || (!exact && section.startsWith(`${href}/`)))) total += count;
  }
  return total;
}

/** The notification types a visit to `pathname` should mark as read (only those that live exactly on that page). */
export function unreadTypesForPath(counts, pathname, can) {
  return Object.keys(counts ?? {}).filter((type) => sectionForType(type, can) === pathname);
}
