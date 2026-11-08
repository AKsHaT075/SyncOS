import { Badge } from "@/components/ui/badge";
import { VISIBILITY_OPTIONS } from "@/features/documents/constants/documentOptions";

export default function VisibilityBadge({ document }) {
  const option = VISIBILITY_OPTIONS.find((item) => item.value === document.visibility);
  if (!option) return null;
  const Icon = option.icon;
  const target = document.visibility === "team" ? document.team?.name : document.visibility === "project" ? document.project?.name : null;
  return (
    <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
      <Icon className="size-3" />
      {option.label}
      {target ? <span className="max-w-24 truncate">· {target}</span> : null}
    </Badge>
  );
}
