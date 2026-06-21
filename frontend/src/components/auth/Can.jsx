"use client";

import { usePermission } from "@/features/auth/hooks/usePermission";

export default function Can({ permission, children, fallback = null }) {
  const allowed = usePermission(permission);

  if (!allowed) {
    return fallback;
  }

  return children;
}
