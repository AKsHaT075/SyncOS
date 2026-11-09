"use client";

import { useParams } from "next/navigation";
import { PERMISSIONS } from "@/constants/permissions";
import { usePermission } from "@/features/auth/hooks/usePermission";
import { RestrictedState } from "@/features/analytics/components/ui";
import { AnalyticsView } from "@/features/analytics/components/views";
import { presetRange } from "@/features/analytics/utils/format";

// Task analytics for this one project (last 30 days). The server re-checks that the viewer may see the project.
export default function ProjectAnalyticsPage() {
  const { projectId } = useParams();
  const allowed = usePermission(PERMISSIONS.VIEW_ANALYTICS);
  if (!allowed) return <RestrictedState title="Project analytics aren't available for your role" />;
  return <AnalyticsView type="tasks" params={{ ...presetRange("30"), projectId }} />;
}
