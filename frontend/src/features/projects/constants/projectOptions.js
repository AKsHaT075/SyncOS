// Mirrors backend/src/constants/project.constants.js — keep these enums in sync.
export const PROJECT_STATUSES = ["Planning", "Active", "On Hold", "Completed", "Archived"];
export const PROJECT_PRIORITIES = ["Low", "Medium", "High", "Critical"];
export const PROJECT_VISIBILITIES = ["Private", "Team", "Organization"];
export const PROJECT_TYPES = ["Technical", "Design", "Marketing", "Operations", "Research", "Other"];

// What the optional "resource link" field means for each project type.
export const PROJECT_TYPE_RESOURCE_LINK = {
  Technical: { label: "GitHub Repository", placeholder: "https://github.com/org/repo" },
  Design: { label: "Design File Link", placeholder: "https://figma.com/file/..." },
  Marketing: { label: "Campaign Brief / Asset Link", placeholder: "https://drive.google.com/..." },
  Operations: { label: "SOP / Process Doc Link", placeholder: "https://docs.google.com/..." },
  Research: { label: "Research Doc / Paper Link", placeholder: "https://docs.google.com/..." },
  Other: { label: "Resource Link", placeholder: "https://..." },
};
export const PROJECT_MEMBER_ROLES = ["Owner", "Manager", "Contributor", "Viewer"];

export const STATUS_STYLES = {
  Planning: "bg-zinc-100 text-zinc-600",
  Active: "bg-emerald-50 text-emerald-700",
  "On Hold": "bg-amber-50 text-amber-700",
  Completed: "bg-blue-50 text-blue-700",
  Archived: "bg-zinc-200 text-zinc-500",
};

export const PRIORITY_STYLES = {
  Low: "bg-zinc-100 text-zinc-600",
  Medium: "bg-blue-50 text-blue-700",
  High: "bg-amber-50 text-amber-700",
  Critical: "bg-red-50 text-red-700",
};
