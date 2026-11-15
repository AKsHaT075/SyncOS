"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PERMISSIONS } from "@/constants/permissions";
import { usePermission } from "@/features/auth/hooks/usePermission";
import AiSettingsPanel from "@/features/ai/components/AiSettingsPanel";
import { Card } from "@/components/ui/card";

export default function AiSettingsPage() {
  const allowed = usePermission(PERMISSIONS.MANAGE_AI);
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <Link href="/dashboard/settings" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Settings
      </Link>
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-foreground">AI settings</h1>
        <p className="text-sm text-muted-foreground">Control whether AI is available in your organization and how much it can be used.</p>
      </div>
      {allowed ? <AiSettingsPanel /> : <Card className="p-5 text-sm text-muted-foreground">Only organization administrators can change AI settings.</Card>}
    </div>
  );
}
