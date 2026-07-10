"use client";

import { useEffect } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/useAuthStore";
import { useUIStore } from "@/store/useUIStore";

export default function OrganizationSwitcher({ collapsed, variant = "sidebar" }) {
  const organizationDetails = useAuthStore((state) => state.organizationDetails);
  const activeOrganization = useUIStore((state) => state.activeOrganization);
  const setActiveOrganization = useUIStore((state) => state.setActiveOrganization);

  // Single-org accounts today; this keeps the switcher ready for when
  // a user can belong to more than one organization.
  const organizations = organizationDetails ? [organizationDetails] : [];

  useEffect(() => {
    if (!activeOrganization && organizations.length > 0) {
      setActiveOrganization(organizations[0]);
    }
  }, [activeOrganization, organizations, setActiveOrganization]);

  const current = activeOrganization ?? organizations[0];
  const initial = current?.name?.[0]?.toUpperCase() ?? "?";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "topbar" ? (
          <button
            type="button"
            className="flex shrink-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-100"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-sm font-semibold text-white shadow-sm shadow-violet-500/30">
              {initial}
            </span>
            <span className="hidden flex-col lg:flex">
              <span className="truncate text-sm font-semibold leading-tight text-zinc-900">
                {current?.name ?? "No organization"}
              </span>
              <span className="text-xs text-zinc-500">Workspace</span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-zinc-400" />
          </button>
        ) : (
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] p-2.5 text-left shadow-sm transition-colors hover:border-white/15 hover:bg-white/[0.07]",
              collapsed && "justify-center px-2"
            )}
          >
            {collapsed ? (
              <span className="text-sm font-semibold text-zinc-300">{initial}</span>
            ) : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-medium tracking-wide text-zinc-500">Workspace</span>
                  <span className="block truncate text-sm font-semibold leading-tight text-zinc-100">
                    {current?.name ?? "No organization"}
                  </span>
                </span>
                <ChevronsUpDown className="size-4 shrink-0 text-zinc-500" />
              </>
            )}
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={cn(
          "w-64",
          variant === "sidebar" &&
            "border-white/10 bg-zinc-900 text-zinc-100 shadow-2xl shadow-black/40"
        )}
      >
        <DropdownMenuLabel
          className={cn(variant === "sidebar" && "text-zinc-500")}
        >
          Organizations
        </DropdownMenuLabel>
        <DropdownMenuSeparator className={cn(variant === "sidebar" && "bg-white/10")} />
        {organizations.map((org) => (
          <DropdownMenuItem
            key={org.id ?? org.name}
            onSelect={() => setActiveOrganization(org)}
            className={cn(
              variant === "sidebar" &&
                "text-zinc-200 focus:bg-white/[0.08] focus:text-zinc-50 data-[highlighted]:bg-white/[0.08] data-[highlighted]:text-zinc-50"
            )}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-indigo-600 text-[11px] font-semibold text-white">
              {org.name?.[0]?.toUpperCase() ?? "?"}
            </span>
            <span className="truncate">{org.name}</span>
            {current?.id === org.id && <Check className="ml-auto size-4 text-violet-400" />}
          </DropdownMenuItem>
        ))}
        {organizations.length === 0 && (
          <DropdownMenuItem
            disabled
            className={cn(variant === "sidebar" && "text-zinc-500")}
          >
            No organizations yet
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
