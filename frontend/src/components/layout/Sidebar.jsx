"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import Can from "@/components/auth/Can";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/useUIStore";
import { NAV_GROUPS, QUICK_LINKS, SETTINGS_ITEM } from "@/components/layout/navConfig";
import SidebarItem from "@/components/layout/SidebarItem";
import SidebarProfile from "@/components/layout/SidebarProfile";
import OrganizationSwitcher from "@/components/layout/OrganizationSwitcher";

export default function Sidebar() {
  const collapsed = useUIStore((state) => state.sidebarCollapsed);
  const notifications = useUIStore((state) => state.notifications);
  const unreadCount = notifications.filter((item) => !item.read).length;
  const pathname = usePathname();

  const [openGroups, setOpenGroups] = useState(() =>
    Object.fromEntries(
      NAV_GROUPS.map((group) => [
        group.label,
        group.items.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`)),
      ])
    )
  );
  const toggleGroup = (label) =>
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }));

  return (
    <aside
      className={cn(
        "hidden h-full flex-col border-r border-white/[0.06] bg-gradient-to-b from-zinc-950 via-zinc-950 to-[#150f23] transition-all duration-200 md:flex",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-white/[0.06] pr-4",
          collapsed ? "pl-3" : "pl-1"
        )}
      >
        <Link href="/dashboard" className="flex items-center overflow-hidden">
          {collapsed ? (
            <Image
              src="/images/logo-collapsed.png"
              alt="Sync OS"
              width={36}
              height={36}
              className="size-9 shrink-0 object-contain"
              priority
            />
          ) : (
            <Image
              src="/images/logo.png"
              alt="Sync OS"
              width={300}
              height={100}
              className="h-9 w-auto shrink-0 object-contain"
              priority
            />
          )}
        </Link>
      </div>

      <div className="px-3 pt-4 pb-3">
        <OrganizationSwitcher collapsed={collapsed} />
      </div>

      <div className="space-y-0.5 px-3 pb-3">
        {QUICK_LINKS.map((item) => (
          <SidebarItem
            key={item.href}
            item={item}
            collapsed={collapsed}
            badge={item.label === "Notifications" ? unreadCount : 0}
          />
        ))}
      </div>

      <div className="mx-4 border-t border-white/[0.06]" />

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {NAV_GROUPS.map((group, index) => {
          const isOpen = collapsed || openGroups[group.label];
          return (
            <div key={group.label} className="space-y-0.5">
              {collapsed ? (
                index > 0 && <div className="mx-2 mb-1.5 border-t border-white/[0.06]" />
              ) : (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label)}
                  aria-expanded={isOpen}
                  className="group flex w-full items-center justify-between rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  <span>{group.label}</span>
                  <ChevronDown
                    className={cn(
                      "size-3 shrink-0 text-zinc-600 opacity-0 transition-all duration-150 group-hover:opacity-100",
                      !isOpen && "-rotate-90 opacity-100"
                    )}
                  />
                </button>
              )}
              {isOpen && (
                <div className="space-y-0.5">
                  {group.items.map((item) =>
                    item.permission ? (
                      <Can key={item.href} permission={item.permission}>
                        <SidebarItem item={item} collapsed={collapsed} />
                      </Can>
                    ) : (
                      <SidebarItem key={item.href} item={item} collapsed={collapsed} />
                    )
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="space-y-0.5 border-t border-white/[0.06] px-3 py-2">
        <SidebarItem item={SETTINGS_ITEM} collapsed={collapsed} />
      </div>

      <SidebarProfile collapsed={collapsed} />
    </aside>
  );
}
