export { PRESETS } from "@/features/analytics/utils/format";

export function formatNumber(value, suffix = "") {
  if (value === null || value === undefined) return "—";
  return `${typeof value === "number" ? value.toLocaleString() : value}${suffix}`;
}
