"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, ChevronsUpDown, CheckSquare, Menu, PanelLeft, Sparkles } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useUIStore } from "@/store/useUIStore";
import SearchBar from "@/components/layout/SearchBar";
import UserMenu from "@/components/layout/UserMenu";
import ProjectSwitcher from "@/components/layout/ProjectSwitcher";
import { NAV_ITEMS, QUICK_LINKS, SETTINGS_ITEM } from "@/components/layout/navConfig";
import { useTask } from "@/features/tasks/hooks/useTask";
import { useTasks } from "@/features/tasks/hooks/useTasks";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...QUICK_LINKS, SETTINGS_ITEM];
const TASK_DETAIL_PATTERN = /^\/dashboard\/projects\/([^/]+)\/tasks\/([^/]+)$/;
const TASK_LIST_PATTERN = /^\/dashboard\/projects\/([^/]+)\/tasks\/?$/;
const TASK_TAB_LABELS = {
  overview: "Overview",
  attachments: "Attachments",
  activity: "Activity",
  members: "Members",
};

// Every project detail tab is a real route (mirrors the TABS list in
// [projectId]/layout.js), so the breadcrumb just needs to label whichever
// segment follows the project id.
const PROJECT_ROOT_PATTERN = /^\/dashboard\/projects\/([^/]+)$/;
const PROJECT_SUBTAB_PATTERN = /^\/dashboard\/projects\/([^/]+)\/(members|meetings|resources|goals|activity|analytics|settings)\/?$/;
const PROJECT_TAB_LABELS = {
  members: "Members",
  meetings: "Meetings",
  resources: "Resources",
  goals: "Goals",
  activity: "Activity",
  analytics: "Analytics",
  settings: "Settings",
};

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

// Plain "Tasks" link back to the project's task list — shown on the task
// detail page, ahead of the task-name dropdown.
function TasksLink({ projectId }) {
  return (
    <Link
      href={`/dashboard/projects/${projectId}/tasks`}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
    >
      <CheckSquare className="size-4 shrink-0 text-zinc-400" />
      <span className="truncate">Tasks</span>
    </Link>
  );
}

// Dropdown showing the current task's name; opens a popover listing every
// other task in the same project so the user can jump directly between them.
function TaskSwitcher({ projectId, taskId }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);

  const { data: taskData } = useTask(projectId, taskId);
  const { data: listData, isFetching } = useTasks(projectId, { search: debouncedSearch, limit: 20 });
  const tasks = listData?.tasks ?? [];
  const task = taskData?.task;

  const otherTasks = useMemo(
    () => tasks.filter((candidate) => candidate.id !== taskId),
    [tasks, taskId]
  );

  const handleSelect = (id) => {
    setOpen(false);
    setSearch("");
    router.push(`/dashboard/projects/${projectId}/tasks/${id}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 max-w-md min-w-0 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 transition-colors hover:bg-zinc-50"
        >
          <span className="truncate whitespace-nowrap">{task?.title || "Loading..."}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-zinc-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <Input
          placeholder="Switch task..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoFocus
        />
        <div className="mt-1 max-h-72 space-y-0.5 overflow-y-auto">
          {isFetching ? (
            <p className="p-2 text-xs text-muted-foreground">Searching...</p>
          ) : otherTasks.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">No other tasks found.</p>
          ) : (
            otherTasks.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => handleSelect(candidate.id)}
                className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-accent"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-zinc-100">
                  <CheckSquare className="size-3.5 text-zinc-500" />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{candidate.title}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Breadcrumbs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const taskDetailMatch = pathname.match(TASK_DETAIL_PATTERN);
  const isTaskDetail = Boolean(taskDetailMatch);
  const isTaskList = TASK_LIST_PATTERN.test(pathname);
  const fromMyTasks = searchParams.get("from") === "mytasks";
  const current = useCurrentNavItem();
  if (!current) return null;

  const Icon = current.icon;
  const onSectionRoot = pathname === current.href;

  // On task detail pages opened from My Tasks, show "My Tasks > Tasks > [Tab]" breadcrumb
  if (isTaskDetail && fromMyTasks) {
    const tasksNavItem = ALL_NAV_ITEMS.find((item) => item.href === "/dashboard/tasks");
    if (tasksNavItem) {
      const TasksIcon = tasksNavItem.icon;
      const tabLabel = TASK_TAB_LABELS[searchParams.get("tab")] || TASK_TAB_LABELS.overview;
      return (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          <Link
            href="/dashboard/tasks"
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <TasksIcon className="size-4 shrink-0 text-zinc-400" />
            <span className="truncate">{tasksNavItem.label}</span>
          </Link>
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <span className="rounded-lg px-2 py-1.5 text-[13px] font-medium text-zinc-500">Tasks</span>
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <span className="text-[13px] font-semibold text-zinc-900">{tabLabel}</span>
        </nav>
      );
    }
  }

  // On the task list page, show "Projects > [Project] > Tasks" (Tasks is current)
  if (isTaskList) {
    const projectsNavItem = ALL_NAV_ITEMS.find((item) => item.href === "/dashboard/projects");
    if (projectsNavItem) {
      const ProjectsIcon = projectsNavItem.icon;
      return (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          <Link
            href="/dashboard/projects"
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <ProjectsIcon className="size-4 shrink-0 text-zinc-400" />
            <span className="truncate">{projectsNavItem.label}</span>
          </Link>
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <ProjectSwitcher />
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <span className="rounded-lg px-2 py-1.5 text-[13px] font-semibold text-zinc-900">Tasks</span>
        </nav>
      );
    }
  }

  // On task detail pages from Projects, show "Projects > [Project] > Tasks > [Task name] > [Tab]"
  if (isTaskDetail && !fromMyTasks) {
    const [, projectId, taskId] = taskDetailMatch;
    const projectsNavItem = ALL_NAV_ITEMS.find((item) => item.href === "/dashboard/projects");
    if (projectsNavItem) {
      const ProjectsIcon = projectsNavItem.icon;
      const tabLabel = TASK_TAB_LABELS[searchParams.get("tab")] || TASK_TAB_LABELS.overview;
      return (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          <Link
            href="/dashboard/projects"
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <ProjectsIcon className="size-4 shrink-0 text-zinc-400" />
            <span className="truncate">{projectsNavItem.label}</span>
          </Link>
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <ProjectSwitcher />
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <TasksLink projectId={projectId} />
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <TaskSwitcher projectId={projectId} taskId={taskId} />
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <span className="text-[13px] font-semibold text-zinc-900">{tabLabel}</span>
        </nav>
      );
    }
  }

  // On a project sub-tab route (Members, Meetings, Resources, Goals,
  // Activity, Analytics, Settings), show "Projects > [Project] > [Tab]"
  const subtabMatch = pathname.match(PROJECT_SUBTAB_PATTERN);
  if (subtabMatch) {
    const tabLabel = PROJECT_TAB_LABELS[subtabMatch[2]];
    const projectsNavItem = ALL_NAV_ITEMS.find((item) => item.href === "/dashboard/projects");
    if (tabLabel && projectsNavItem) {
      const ProjectsIcon = projectsNavItem.icon;
      return (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          <Link
            href="/dashboard/projects"
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <ProjectsIcon className="size-4 shrink-0 text-zinc-400" />
            <span className="truncate">{projectsNavItem.label}</span>
          </Link>
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <ProjectSwitcher />
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <span className="text-[13px] font-semibold text-zinc-900">{tabLabel}</span>
        </nav>
      );
    }
  }

  // On the project overview route itself, show "Projects > [Project] > Overview"
  const rootMatch = pathname.match(PROJECT_ROOT_PATTERN);
  if (rootMatch && rootMatch[1] !== "new") {
    const projectsNavItem = ALL_NAV_ITEMS.find((item) => item.href === "/dashboard/projects");
    if (projectsNavItem) {
      const ProjectsIcon = projectsNavItem.icon;
      return (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          <Link
            href="/dashboard/projects"
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <ProjectsIcon className="size-4 shrink-0 text-zinc-400" />
            <span className="truncate">{projectsNavItem.label}</span>
          </Link>
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <ProjectSwitcher />
          <ChevronRight className="size-3.5 shrink-0 text-zinc-300" />
          <span className="text-[13px] font-semibold text-zinc-900">Overview</span>
        </nav>
      );
    }
  }

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
        <SearchBar compact />
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
