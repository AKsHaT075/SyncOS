export const number = (value) => (value === null || value === undefined ? "—" : Number(value).toLocaleString());
export const percentText = (value) => (value === null || value === undefined ? "—" : `${value}%`);

/** 'YYYY-MM-DD' or 'YYYY-MM' bucket → short axis label (never shifted by timezone). */
export function bucketLabel(bucket) {
  if (!bucket) return "";
  const parts = String(bucket).split("-").map(Number);
  if (parts.length === 2) return new Date(Date.UTC(parts[0], parts[1] - 1, 1)).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export const isoDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const PRESETS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
  { value: "custom", label: "Custom range" },
];

/** Range query for a preset (the server resolves "today" in the organization's timezone; this is only the request). */
export function presetRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (Number(days) - 1));
  return { from: isoDay(start), to: isoDay(end) };
}

export const labelOf = (key) => String(key ?? "").replace(/_/g, " ");

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
