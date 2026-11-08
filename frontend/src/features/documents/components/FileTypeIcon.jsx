import { fileTypeStyle } from "@/features/documents/utils/format";

export default function FileTypeIcon({ category, className = "size-9", iconClassName = "size-4.5" }) {
  const { icon: Icon, className: tone } = fileTypeStyle(category);
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg ${tone} ${className}`} aria-hidden="true">
      <Icon className={iconClassName} />
    </span>
  );
}
