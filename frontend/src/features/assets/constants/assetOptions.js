// Mirrors backend/src/constants/asset.constants.js

export const STATUSES = [
  { value: "AVAILABLE", label: "Available", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", dot: "#10b981" },
  { value: "ASSIGNED", label: "Assigned", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400", dot: "#3b82f6" },
  { value: "UNDER_MAINTENANCE", label: "Under maintenance", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400", dot: "#f59e0b" },
  { value: "RESERVED", label: "Reserved", tone: "bg-violet-500/10 text-violet-700 dark:text-violet-400", dot: "#8b5cf6" },
  { value: "RETIRED", label: "Retired", tone: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400", dot: "#71717a" },
  { value: "DISPOSED", label: "Disposed", tone: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-500", dot: "#a1a1aa" },
  { value: "LOST", label: "Lost", tone: "bg-red-500/10 text-red-700 dark:text-red-400", dot: "#ef4444" },
];
export const STATUS_BY_VALUE = Object.fromEntries(STATUSES.map((status) => [status.value, status]));

export const CONDITIONS = [
  { value: "NEW", label: "New" },
  { value: "GOOD", label: "Good" },
  { value: "FAIR", label: "Fair" },
  { value: "POOR", label: "Poor" },
  { value: "DAMAGED", label: "Damaged" },
];

export const KINDS = [
  { value: "hardware", label: "Hardware" },
  { value: "software", label: "Software license" },
];

export const LICENSE_TYPES = [
  { value: "PER_SEAT", label: "Per seat" },
  { value: "SITE", label: "Site / organization" },
  { value: "SUBSCRIPTION", label: "Subscription" },
  { value: "OPEN_SOURCE", label: "Open source" },
  { value: "PERPETUAL", label: "Perpetual" },
];

export const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "JPY"];

export const MAINTENANCE_TYPES = [
  { value: "REPAIR", label: "Repair" },
  { value: "PREVENTIVE", label: "Preventive" },
  { value: "INSPECTION", label: "Inspection" },
  { value: "UPGRADE", label: "Upgrade" },
  { value: "OTHER", label: "Other" },
];

export const MAINTENANCE_STATUSES = {
  REQUESTED: { label: "Requested", tone: "bg-violet-500/10 text-violet-700 dark:text-violet-400" },
  SCHEDULED: { label: "Scheduled", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400" },
  IN_PROGRESS: { label: "In progress", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  COMPLETED: { label: "Completed", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  CANCELLED: { label: "Cancelled", tone: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400" },
};

export const DOCUMENT_KINDS = [
  { value: "invoice", label: "Invoice" },
  { value: "warranty", label: "Warranty" },
  { value: "manual", label: "Manual" },
  { value: "assignment_agreement", label: "Assignment agreement" },
  { value: "maintenance_report", label: "Maintenance report" },
  { value: "image", label: "Photo" },
  { value: "other", label: "Other" },
];

export const WARRANTY_FILTERS = [
  { value: "active", label: "In warranty" },
  { value: "expiring", label: "Expiring soon" },
  { value: "expired", label: "Expired" },
  { value: "none", label: "No warranty" },
];

export const SORTS = [
  { value: "createdAt", label: "Recently added" },
  { value: "name", label: "Name" },
  { value: "assetId", label: "Asset ID" },
  { value: "status", label: "Status" },
  { value: "purchaseDate", label: "Purchase date" },
  { value: "warrantyExpiry", label: "Warranty expiry" },
  { value: "cost", label: "Cost" },
];

// Mirrors the audit log actions shown on an asset's Activity tab.
export const ACTIVITY_LABELS = {
  "asset.created": "Added to inventory",
  "asset.updated": "Details updated",
  "asset.archived": "Archived",
  "asset.restored": "Restored",
  "asset.assigned": "Assigned",
  "asset.transferred": "Transferred",
  "asset.returned": "Returned",
  "asset.return_requested": "Return requested",
  "asset.status_changed": "Status changed",
  "asset.license_updated": "License details updated",
  "asset.document_linked": "Document linked",
  "asset.document_unlinked": "Document unlinked",
  "asset.maintenance_requested": "Maintenance requested",
  "asset.maintenance_scheduled": "Maintenance scheduled",
  "asset.maintenance_started": "Maintenance started",
  "asset.maintenance_completed": "Maintenance completed",
  "asset.maintenance_cancelled": "Maintenance cancelled",
  "asset.integrity_repaired": "Record reconciled automatically",
};
