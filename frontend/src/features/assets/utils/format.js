/** Date-only values arrive as "YYYY-MM-DD" and are shown as that same calendar day — never shifted by timezone. */
export function formatDay(value) {
  if (!value) return "—";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
}

export function formatDateTime(value) {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

export function formatMoney(amount, currency = "INR") {
  if (amount === null || amount === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

const DAY_MS = 86400000;
export function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Whole days from today until a "YYYY-MM-DD" date (negative = in the past). */
export function daysUntil(value) {
  if (!value) return null;
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = todayString().split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / DAY_MS);
}

export function expiryLabel(value) {
  const days = daysUntil(value);
  if (days === null) return null;
  if (days < 0) return { text: `Expired ${-days} day${days === -1 ? "" : "s"} ago`, tone: "text-destructive" };
  if (days === 0) return { text: "Expires today", tone: "text-destructive" };
  if (days <= 30) return { text: `Expires in ${days} day${days === 1 ? "" : "s"}`, tone: "text-amber-600 dark:text-amber-400" };
  return { text: `Expires ${formatDay(value)}`, tone: "text-muted-foreground" };
}

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

/** Drops empty strings so optional fields are omitted rather than sent as "". */
export function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== "" && value !== undefined));
}
