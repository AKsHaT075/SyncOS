import { presetRange } from "@/features/analytics/utils/format";

const KEYS = ["preset", "from", "to", "teamId", "userId", "projectId"];

/** Reads the filter state out of the URL query. */
export const filtersFromParams = (params) => Object.fromEntries(KEYS.map((key) => [key, params.get(key) ?? ""]));

/** The query the API expects: a preset becomes concrete dates, "custom" uses the typed ones. */
export function apiParams(filters) {
  const preset = filters.preset || "30";
  const range = preset === "custom" ? { from: filters.from, to: filters.to } : presetRange(preset);
  return { ...range, teamId: filters.teamId, userId: filters.userId, projectId: filters.projectId };
}
