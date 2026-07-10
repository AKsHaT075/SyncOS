import { Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";

export default function ComingSoon({ icon: Icon = Sparkles, title, description }) {
  return (
    <Card className="flex flex-col items-center gap-2 p-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4.5" />
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{description || "This is coming in a future update."}</p>
    </Card>
  );
}
