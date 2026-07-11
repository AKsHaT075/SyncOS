"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckSquare, LayoutGrid, List, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { useMyTasks } from "@/features/tasks/hooks/useMyTasks";
import {
  PRIORITY_STYLES,
  STATUS_STYLES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "@/features/tasks/constants/taskOptions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

const ALL = "all";

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function MyTasksPage() {
  const [view, setView] = useState("table");
  const [searchInput, setSearchInput] = useState("");
  const [status, setStatus] = useState(ALL);
  const [priority, setPriority] = useState(ALL);
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);

  const search = useDebouncedValue(searchInput);

  useEffect(() => {
    setPage(1);
  }, [search, status, priority, archived]);

  const { data, isLoading, isError } = useMyTasks({
    page,
    limit: 20,
    ...(search && { search }),
    ...(status !== ALL && { status }),
    ...(priority !== ALL && { priority }),
    archived,
  });

  const tasks = data?.tasks ?? [];
  const pagination = data?.pagination;

  const stats = {
    total: pagination?.total || 0,
    active: tasks.filter((t) => t.status !== "Completed").length,
    completed: tasks.filter((t) => t.status === "Completed").length,
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-background/95">
      <div className="space-y-6 p-6 max-w-7xl mx-auto">
        {/* Page Header */}
        <div className="space-y-1">
          <h1 className="text-3xl font-bold text-zinc-900">My Tasks</h1>
          <p className="text-sm text-muted-foreground">Tasks assigned to you across all projects</p>
        </div>

        {/* Stats */}
        {!isLoading && !isError && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatsCard label="Total Tasks" value={stats.total} color="from-blue-500/10 to-blue-500/5" />
            <StatsCard label="In Progress" value={stats.active} color="from-amber-500/10 to-amber-500/5" />
            <StatsCard label="Completed" value={stats.completed} color="from-green-500/10 to-green-500/5" />
          </div>
        )}

        {/* Filters */}
        <div className="space-y-3 rounded-lg border border-border bg-card p-4 backdrop-blur-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search tasks by title..."
                className="pl-9 bg-background/50"
              />
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-border bg-background/50 p-1">
              <Button variant={view === "table" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setView("table")} title="Table view">
                <List className="size-4" />
              </Button>
              <Button variant={view === "grid" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setView("grid")} title="Grid view">
                <LayoutGrid className="size-4" />
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger size="sm" className="w-auto bg-background/50">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  {TASK_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger size="sm" className="w-auto bg-background/50">
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All priorities</SelectItem>
                  {TASK_PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                variant={archived ? "secondary" : "outline"}
                size="sm"
                onClick={() => setArchived((v) => !v)}
              >
                {archived ? "Archived" : "Active"}
              </Button>
            </div>
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <Card className="flex items-center justify-center py-12">
            <EmptyStateCard
              icon={AlertCircle}
              title="Couldn't load tasks"
              description="Please try again in a moment."
            />
          </Card>
        ) : tasks.length === 0 ? (
          <Card className="flex items-center justify-center py-12">
            <EmptyStateCard
              icon={CheckSquare}
              title="No tasks found"
              description={archived ? "No archived tasks match your filters." : "All caught up — no tasks assigned to you."}
            />
          </Card>
        ) : view === "table" ? (
          <MyTasksTable tasks={tasks} />
        ) : (
          <MyTasksGrid tasks={tasks} />
        )}

        {/* Pagination */}
        {pagination && pagination.pages > 1 && (
          <div className="flex items-center justify-between border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Page <span className="font-semibold">{pagination.page}</span> of <span className="font-semibold">{pagination.pages}</span> ·
              <span className="font-semibold ml-1">{pagination.total}</span> tasks
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= pagination.pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatsCard({ label, value, color }) {
  return (
    <Card className={`overflow-hidden border-0 bg-gradient-to-br ${color}`}>
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold tracking-tight text-foreground">{value}</p>
          </div>
          <CheckSquare className="size-5 text-muted-foreground opacity-60" />
        </div>
      </div>
    </Card>
  );
}

function isOverdue(task) {
  if (!task.dueDate || task.status === "Completed") return false;
  return new Date(task.dueDate) < new Date(new Date().toDateString());
}

function MyTasksTable({ tasks }) {
  return (
    <Card className="overflow-hidden rounded-xl border border-border py-0 shadow-sm ring-0">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-border bg-muted/40 hover:bg-muted/40">
            <TableHead className="h-11 pl-5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Task</TableHead>
            <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Project</TableHead>
            <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Status</TableHead>
            <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Priority</TableHead>
            <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Owner</TableHead>
            <TableHead className="h-11 pr-5 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase">Due Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => {
            const overdue = isOverdue(task);
            return (
              <TableRow key={task.id} className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/30">
                <TableCell className="py-3.5 pl-5">
                  <Link
                    href={`/dashboard/projects/${task.project?.id || task.projectId}/tasks/${task.id}?from=mytasks`}
                    className="font-medium text-foreground transition-colors hover:text-brand hover:underline hover:underline-offset-2"
                  >
                    {task.title}
                  </Link>
                </TableCell>
                <TableCell className="py-3.5 text-sm text-muted-foreground">
                  {task.project?.name || "—"}
                </TableCell>
                <TableCell className="py-3.5">
                  <Badge className={`${STATUS_STYLES[task.status]} rounded-full px-2.5 py-0.5 font-medium`} variant="outline">
                    {task.status}
                  </Badge>
                </TableCell>
                <TableCell className="py-3.5">
                  <Badge className={`${PRIORITY_STYLES[task.priority]} rounded-full px-2.5 py-0.5 font-medium`} variant="outline">
                    {task.priority}
                  </Badge>
                </TableCell>
                <TableCell className="py-3.5">
                  {task.owner ? (
                    <div className="flex items-center gap-2">
                      <Avatar size="sm" className="ring-1 ring-border">
                        <AvatarFallback className="bg-muted text-[11px] font-semibold text-muted-foreground">
                          {initials(task.owner.fullName)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm text-zinc-600">{task.owner.fullName}</span>
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell
                  className={`py-3.5 pr-5 text-right text-xs tabular-nums ${overdue ? "font-medium text-red-600" : "text-muted-foreground"}`}
                >
                  {task.dueDate
                    ? new Date(task.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                    : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

function MyTasksGrid({ tasks }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tasks.map((task) => {
        const overdue = isOverdue(task);
        return (
        <Link
          key={task.id}
          href={`/dashboard/projects/${task.project?.id || task.projectId}/tasks/${task.id}?from=mytasks`}
          className="block"
        >
          <Card className="group h-full overflow-hidden rounded-xl border border-border shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md">
            <div className="flex h-full flex-col gap-3 p-5">
              <div className="space-y-1">
                <p className="truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {task.project?.name || "Task"}
                </p>
                <h3 className="truncate font-semibold text-foreground transition-colors group-hover:text-brand">
                  {task.title}
                </h3>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className={`${STATUS_STYLES[task.status]} rounded-full px-2.5 py-0.5 text-xs font-medium`} variant="outline">
                  {task.status}
                </Badge>
                <Badge className={`${PRIORITY_STYLES[task.priority]} rounded-full px-2.5 py-0.5 text-xs font-medium`} variant="outline">
                  {task.priority}
                </Badge>
              </div>

              <div className="flex-1" />

              <div className="flex items-center justify-between border-t border-border/60 pt-3">
                {task.owner ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar size="sm" className="ring-1 ring-border">
                      <AvatarFallback className="bg-muted text-[11px] font-semibold text-muted-foreground">
                        {initials(task.owner.fullName)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate text-xs text-zinc-600">{task.owner.fullName}</span>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">Unassigned</span>
                )}
                {task.dueDate && (
                  <span className={`ml-auto shrink-0 text-xs tabular-nums ${overdue ? "font-medium text-red-600" : "text-muted-foreground"}`}>
                    Due {new Date(task.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                )}
              </div>
            </div>
          </Card>
        </Link>
        );
      })}
    </div>
  );
}
