"use client";

import { Suspense } from "react";
import { ShieldAlert } from "lucide-react";
import Can from "@/components/auth/Can";
import { Skeleton } from "@/components/ui/skeleton";
import { PERMISSIONS } from "@/constants/permissions";
import AiStudio from "@/features/ai/components/AiStudio";

function NoAccess() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-background px-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"><ShieldAlert className="size-5" /></span>
      <h1 className="text-base font-semibold text-foreground">AI Studio is not available for your role</h1>
      <p className="max-w-sm text-sm text-muted-foreground">Ask an administrator if you need access.</p>
    </div>
  );
}

export default function AiStudioPage() {
  return (
    <Can permission={PERMISSIONS.USE_AI} fallback={<NoAccess />}>
      <Suspense fallback={<div className="h-full bg-background p-6"><Skeleton className="h-8 w-48" /></div>}>
        <AiStudio />
      </Suspense>
    </Can>
  );
}
