import {
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Presentation,
} from "lucide-react";

export function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

export function formatDate(value, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  return withTime
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

const ICONS = {
  pdf: { icon: FileText, className: "bg-red-500/10 text-red-600 dark:text-red-400" },
  word: { icon: FileType2, className: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  excel: { icon: FileSpreadsheet, className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  csv: { icon: FileSpreadsheet, className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  powerpoint: { icon: Presentation, className: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
  image: { icon: FileImage, className: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  archive: { icon: FileArchive, className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  text: { icon: FileText, className: "bg-muted text-muted-foreground" },
};

export function fileTypeStyle(category) {
  return ICONS[category] ?? { icon: File, className: "bg-muted text-muted-foreground" };
}

export function getExtension(name) {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}
