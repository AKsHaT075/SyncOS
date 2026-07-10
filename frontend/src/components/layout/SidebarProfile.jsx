"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/useAuthStore";
import UserMenu from "@/components/layout/UserMenu";
import { useUpdateStatus } from "@/features/auth/hooks/useUpdateStatus";
import { PRESENCE_OPTIONS, PRESENCE_META, PRESENCE_STATUS } from "@/constants/presence";

const ROLE_LABELS = {
  "org-admin": "Admin",
  "admin": "Co-Admin",
  "hr": "Human Resource",
  "manager": "Manager",
  "employee": "Employee",
  "guest": "Guest",
  "super-admin": "Super Admin",
};

function initialsFor(fullName) {
  if (!fullName) return "U";
  return fullName
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function getRoleLabel(role) {
  return ROLE_LABELS[role] ?? role;
}

export default function SidebarProfile({ collapsed = false }) {
  const user = useAuthStore((state) => state.user);
  const organizationDetails = useAuthStore((state) => state.organizationDetails);
  const status = user?.status ?? PRESENCE_STATUS.OFFLINE;
  const dotClassName = (PRESENCE_META[status] ?? PRESENCE_META[PRESENCE_STATUS.OFFLINE]).dotClassName;
  const updateStatus = useUpdateStatus();

  const roleDisplay = organizationDetails?.name
    ? `${getRoleLabel(user?.role ?? "employee")} · ${organizationDetails.name}`
    : getRoleLabel(user?.role ?? "employee");

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 border-t border-white/[0.06] px-3 py-3",
        collapsed && "justify-center px-2"
      )}
    >
      <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 via-violet-600 to-indigo-600 text-[0.8rem] font-semibold text-white ring-2 ring-white/15">
        {initialsFor(user?.fullName)}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Set status"
              className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-zinc-950 transition-transform hover:scale-125 ${dotClassName}`}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-48">
            <DropdownMenuLabel>Set status</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={status === PRESENCE_STATUS.OFFLINE ? "" : status}
              onValueChange={(value) => updateStatus.mutate(value)}
            >
              {PRESENCE_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value} disabled={updateStatus.isPending}>
                  <span className={`size-2 rounded-full ${option.dotClassName}`} />
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {!collapsed && (
        <>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold leading-tight text-zinc-100">
              {user?.fullName ?? "Account"}
            </span>
            <span className="truncate text-xs text-zinc-400">{roleDisplay}</span>
          </span>
          <UserMenu triggerClassName="text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100" />
        </>
      )}
    </div>
  );
}
