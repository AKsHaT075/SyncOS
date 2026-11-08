"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { X, ChevronDown } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetClose,
} from "@/components/ui/sheet";
import Can from "@/components/auth/Can";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/useUIStore";
import { useUnreadCount } from "@/features/notifications/hooks/notificationHooks";
import { NAV_GROUPS, QUICK_LINKS, SETTINGS_ITEM } from "@/components/layout/navConfig";
import SidebarItem from "@/components/layout/SidebarItem";
import OrganizationSwitcher from "@/components/layout/OrganizationSwitcher";

export default function MobileSidebar() {
  const open = useUIStore((state) => state.mobileSidebarOpen);
  const closeMobileSidebar = useUIStore((state) => state.closeMobileSidebar);
  // Real unread count (kept live by the notification stream) — replaces the old placeholder store.
  const { data: unread } = useUnreadCount();
  const unreadCount = unread?.count ?? 0;
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
    <Sheet open={open} onOpenChange={(value) => !value && closeMobileSidebar()}>
      <SheetContent
        side="left"
        className="flex w-72 flex-col gap-0 bg-gradient-to-b from-zinc-950 via-zinc-950 to-[#150f23] p-0"
        showCloseButton={false}
      >
        <SheetHeader className="h-20 shrink-0 justify-center border-b border-white/[0.06] px-5 py-0">
          <SheetTitle asChild>
            <Link
              href="/dashboard"
              onClick={closeMobileSidebar}
              className="flex items-center"
            >
              <Image
                src="/images/logo.png"
                alt="Sync OS"
                width={300}
                height={100}
                className="h-12 w-auto shrink-0 object-contain"
                priority
              />
            </Link>
          </SheetTitle>
          <SheetClose className="absolute top-4 right-4 flex size-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-100">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </SheetClose>
        </SheetHeader>

        <div className="px-3 pt-4 pb-3">
          <OrganizationSwitcher collapsed={false} />
        </div>

        <div className="space-y-0.5 px-3 pb-3">
          {QUICK_LINKS.map((item) => (
            <SidebarItem
              key={item.href}
              item={item}
              collapsed={false}
              badge={item.label === "Notifications" ? unreadCount : 0}
            />
          ))}
        </div>

        <div className="mx-4 border-t border-white/5" />

        <nav
          className="flex-1 space-y-4 overflow-y-auto px-3 py-4"
          onClick={(event) => {
            if (event.target.closest("a")) closeMobileSidebar();
          }}
        >
          {NAV_GROUPS.map((group) => {
            const isOpen = openGroups[group.label];
            return (
              <div key={group.label} className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-[0.92rem] font-semibold text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                >
                  <span>{group.label}</span>
                  <ChevronDown
                    className={cn("size-4 shrink-0 text-zinc-500 transition-transform duration-150", !isOpen && "-rotate-90")}
                  />
                </button>
                {isOpen && (
                  <div className="space-y-0.5 border-l border-white/[0.06] pl-2.5">
                    {group.items.map((item) =>
                      item.permission ? (
                        <Can key={item.href} permission={item.permission}>
                          <SidebarItem item={item} collapsed={false} />
                        </Can>
                      ) : (
                        <SidebarItem key={item.href} item={item} collapsed={false} />
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div
          className="border-t border-white/5 px-3 py-3"
          onClick={(event) => {
            if (event.target.closest("a")) closeMobileSidebar();
          }}
        >
          <SidebarItem item={SETTINGS_ITEM} collapsed={false} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
