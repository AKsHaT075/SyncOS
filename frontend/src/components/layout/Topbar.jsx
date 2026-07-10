"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Menu, PanelLeft, Sparkles } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUIStore } from "@/store/useUIStore";
import SearchBar from "@/components/layout/SearchBar";
import UserMenu from "@/components/layout/UserMenu";
import ProjectSwitcher from "@/components/layout/ProjectSwitcher";
import { NAV_ITEMS, QUICK_LINKS, SETTINGS_ITEM } from "@/components/layout/navConfig";

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...QUICK_LINKS, SETTINGS_ITEM];

/**
 * Resolves the current page's nav entry from the pathname so the topbar can
 * show where the user is on every page. Longest href prefix wins, so
 * /dashboard/projects/123 maps to "Projects" rather than "Dashboard".
 */
function useCurrentNavItem() {
  const pathname = usePathname();
  return ALL_NAV_ITEMS
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

function Breadcrumbs() {
  const pathname = usePathname();
  const current = useCurrentNavItem();
  if (!current) return null;

  const Icon = current.icon;
  const onSectionRoot = pathname === current.href;

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
      <Link
        href={current.href}
        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors ${
          onSectionRoot
            ? "font-semibold text-zinc-900"
            : "font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
        }`}
      >
        <Icon className="size-4 shrink-0 text-zinc-400" />
        <span className="truncate">{current.label}</span>
      </Link>
      {!onSectionRoot ? <ChevronRight className="size-3.5 shrink-0 text-zinc-300" /> : null}
      <ProjectSwitcher />
    </nav>
  );
}

function AIAssistantButton() {
  const toggleAIPanel = useUIStore((state) => state.toggleAIPanel);
  return (
    <button
      type="button"
      onClick={toggleAIPanel}
      aria-label="Open Sync Copilot"
      className="flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-zinc-100 cursor-pointer"
    >
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <defs>
          <linearGradient id="ai-icon-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#d946ef" />
            <stop offset="55%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#38bdf8" />
          </linearGradient>
        </defs>
      </svg>
      <Sparkles className="size-5" fill="url(#ai-icon-gradient)" stroke="url(#ai-icon-gradient)" />
    </button>
  );
}

export default function Topbar() {
  const openMobileSidebar = useUIStore((state) => state.openMobileSidebar);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const sidebarCollapsed = useUIStore((state) => state.sidebarCollapsed);

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200/60 bg-white/70 px-4 backdrop-blur-xl sm:px-6">
      <button
        type="button"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 md:hidden"
        onClick={openMobileSidebar}
        aria-label="Open sidebar"
      >
        <Menu className="size-4" />
      </button>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="hidden size-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 md:flex"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <PanelLeft className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        </TooltipContent>
      </Tooltip>

      <div className="hidden h-4 w-px shrink-0 bg-zinc-200/80 md:block" />

      <div className="hidden min-w-0 flex-1 items-center md:flex">
        <Breadcrumbs />
      </div>

      <div className="flex flex-1 items-center justify-end gap-1.5 md:flex-none">
        <div className="hidden md:flex md:w-56 lg:w-64">
          <SearchBar />
        </div>
        <div className="md:hidden">
          <SearchBar compact />
        </div>
        <AIAssistantButton />
        {/* Profile lives in the sidebar on desktop; the sidebar is hidden on
            mobile, so keep the account menu reachable here below md. */}
        <div className="md:hidden">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
