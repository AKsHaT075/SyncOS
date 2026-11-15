import { Target } from "lucide-react";
import ComingSoon from "@/components/projects/ComingSoon";

// Goals have no backend yet (the Goal model is an empty placeholder). Kept as an honest page so the sidebar link is not a 404.
export default function GoalsPage() {
  return (
    <div className="space-y-5 p-6">
      <h1 className="text-2xl font-bold text-zinc-900">Goals</h1>
      <ComingSoon icon={Target} title="Goals are coming soon" description="Goal tracking is not available yet. Work is currently tracked through projects and tasks." />
    </div>
  );
}
