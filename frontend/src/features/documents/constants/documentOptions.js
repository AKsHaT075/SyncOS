import { Building2, FolderKanban, Lock, Users2 } from "lucide-react";

// Mirrors backend/src/constants/document.constants.js
export const VISIBILITY = Object.freeze({
  PRIVATE: "private",
  TEAM: "team",
  PROJECT: "project",
  ORGANIZATION: "organization",
});

export const VISIBILITY_OPTIONS = [
  { value: VISIBILITY.PRIVATE, label: "Private", description: "Only you and people you share it with", icon: Lock },
  { value: VISIBILITY.TEAM, label: "Team", description: "Members of a team you choose", icon: Users2 },
  { value: VISIBILITY.PROJECT, label: "Project", description: "Members of a project you choose", icon: FolderKanban },
  { value: VISIBILITY.ORGANIZATION, label: "Organization", description: "Everyone in the organization (guests excluded)", icon: Building2 },
];

export const VISIBILITY_LABEL = Object.fromEntries(VISIBILITY_OPTIONS.map((o) => [o.value, o.label]));

// Roles allowed to publish organization-wide (backend ORG_WIDE_PUBLISH_ROLES).
export const ORG_WIDE_PUBLISH_ROLES = ["org-admin", "admin", "hr", "manager"];

export const CATEGORY_OPTIONS = [
  { value: "pdf", label: "PDF" },
  { value: "word", label: "Word" },
  { value: "excel", label: "Excel" },
  { value: "powerpoint", label: "PowerPoint" },
  { value: "text", label: "Text" },
  { value: "csv", label: "CSV" },
  { value: "image", label: "Images" },
  { value: "archive", label: "Archives" },
];

export const SORT_OPTIONS = [
  { value: "updatedAt", label: "Last modified" },
  { value: "createdAt", label: "Upload date" },
  { value: "name", label: "Name" },
  { value: "size", label: "Size" },
];

export const SCOPE_OPTIONS = [
  { value: "all", label: "All documents" },
  { value: "mine", label: "My documents" },
  { value: "shared", label: "Shared with me" },
];

export const ALLOWED_EXTENSIONS = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "png", "jpg", "jpeg", "zip"];
export const ACCEPT_ATTRIBUTE = ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(",");
// Display hint only — the server enforces the real (configurable) limit.
export const MAX_FILE_SIZE_HINT_MB = 25;

export const INLINE_PREVIEW_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "txt"];

export const ACTION_LABELS = {
  "document.uploaded": "uploaded the document",
  "document.renamed": "renamed the document",
  "document.updated": "updated the details",
  "document.moved": "moved the document",
  "document.visibility_changed": "changed who can see it",
  "document.deleted": "moved it to the trash",
  "document.restored": "restored it from the trash",
  "document.downloaded": "downloaded it",
  "document.shared": "shared it",
  "document.share_revoked": "revoked someone's access",
  "document.version_uploaded": "uploaded a new version",
  "document.version_restored": "restored a previous version",
};
