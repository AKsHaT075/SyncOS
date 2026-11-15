"use client";

import Link from "next/link";
import { Bell, ChevronRight, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PERMISSIONS } from "@/constants/permissions";
import { ROLES } from "@/constants/roles";
import { usePermission } from "@/features/auth/hooks/usePermission";
import { useAuthStore } from "@/store/useAuthStore";
import ProfileForm from "@/features/account/components/ProfileForm";
import PasswordForm from "@/features/account/components/PasswordForm";
import OrganizationForm from "@/features/account/components/OrganizationForm";
import UsageCard from "@/features/account/components/UsageCard";

function LinkCard({ href, icon: Icon, title, description }) {
  return (
    <Link href={href} className="group block">
      <Card className="flex-row items-center gap-3 p-4 transition-colors group-hover:bg-muted/50">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600"><Icon className="size-4.5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          <span className="block text-xs text-muted-foreground">{description}</span>
        </span>
        <ChevronRight className="size-4 text-muted-foreground" />
      </Card>
    </Link>
  );
}

export default function SettingsPage() {
  const role = useAuthStore((state) => state.user?.role);
  const canManageAi = usePermission(PERMISSIONS.MANAGE_AI);
  const isOwner = role === ROLES.ORG_ADMIN;
  const seesUsage = role === ROLES.ORG_ADMIN || role === ROLES.ADMIN;

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account{isOwner ? " and your organization" : ""}.</p>
      </div>

      <ProfileForm />
      <PasswordForm />
      {isOwner ? <OrganizationForm /> : null}
      {seesUsage ? <UsageCard /> : null}

      <div className="space-y-3">
        <LinkCard href="/dashboard/notifications" icon={Bell} title="Notification preferences" description="Choose what you are notified about and by email." />
        {canManageAi ? <LinkCard href="/dashboard/settings/ai" icon={Sparkles} title="AI settings" description="Turn AI on for the organization, review the disclosure and usage limits." /> : null}
      </div>
    </div>
  );
}
