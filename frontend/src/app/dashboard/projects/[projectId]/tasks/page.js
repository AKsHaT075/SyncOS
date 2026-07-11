"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertCircle, CheckSquare, LayoutGrid, List, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarGroup } from "@/components/ui/avatar";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { useAuthStore } from "@/store/useAuthStore";
import { useProject } from "@/features/projects/hooks/useProject";
import { useTasks } from "@/features/tasks/hooks/useTasks";
import { useDeleteTask } from "@/features/tasks/hooks/useDeleteTask";
import { useUpdateTask } from "@/features/tasks/hooks/useUpdateTask";
import {
  KANBAN_COLUMNS,
  PRIORITY_STYLES,
  STATUS_STYLES,
  TASK_MANUAL_STATUS_TRANSITIONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "@/features/tasks/constants/taskOptions";
import { canCreateTaskClient, canManageTaskClient } from "@/features/tasks/utils/permissions";
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

export default function ProjectTasksPage() {
  const { projectId } = useParams();
  const authUser = useAuthStore((state) => state.user);
  const { data: projectData } = useProject(projectId);
  const project = projectData?.project;

  const [view, setView] = useState("table");
  const [searchInput, setSearchInput] = useState("");
  const [status, setStatus] = useState(ALL);
  const [priority, setPriority] = useState(ALL);
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState([]);

  const search = useDebouncedValue(searchInput);

  useEffect(() => {
    setPage(1);
    setSelected([]);
  }, [search, status, priority, archived]);

  const { data, isLoading, isError } = useTasks(projectId, {
    page,
    limit: 20,
    ...(search && { search }),
    ...(status !== ALL && { status }),
    ...(priority !== ALL && { priority }),
    archived,
  });
  const deleteMutation = useDeleteTask(projectId);

  const tasks = data?.tasks ?? [];
  const pagination = data?.pagination;
  const canCreate = canCreateTaskClient(project, authUser);
  const canBulkManage = canManageTaskClient(project, authUser);

  const toggleSelected = (taskId) => {
    setSelected((prev) => (prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]));
  };

  const handleBulkDelete = async () => {
    await Promise.all(selected.map((taskId) => deleteMutation.mutateAsync(taskId)));
    setSelected([]);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
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
            <Button variant={view === "kanban" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setView("kanban")} title="Kanban view">
              <LayoutGrid className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant={status === ALL ? "secondary" : "ghost"}
            size="sm"
            className="rounded-full"
            onClick={() => setStatus(ALL)}
          >
            All
          </Button>
          {TASK_STATUSES.map((value) => (
            <Button
              key={value}
              variant={status === value ? "secondary" : "ghost"}
              size="sm"
              className="gap-1.5 rounded-full"
              onClick={() => setStatus(value)}
            >
              <span className={`size-1.5 rounded-full ${STATUS_DOT_COLORS[value]}`} />
              {value}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
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

            <Button variant={archived ? "secondary" : "outline"} size="sm" onClick={() => setArchived((v) => !v)}>
              {archived ? "Archived" : "Active"}
            </Button>

            {selected.length > 0 && canBulkManage ? (
              <Button variant="outline" size="sm" className="gap-2 text-destructive" onClick={handleBulkDelete}>
                <Trash2 className="size-4" /> Delete {selected.length} selected
              </Button>
            ) : null}
          </div>

          {canCreate ? (
            <Button asChild className="gap-2 bg-brand hover:bg-brand/90">
              <Link href={`/dashboard/projects/${projectId}/tasks/new`}>
                <Plus className="size-4" /> New Task
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <Card className="flex items-center justify-center py-12">
          <EmptyStateCard icon={AlertCircle} title="Couldn't load tasks" description="Please try again in a moment." />
        </Card>
      ) : tasks.length === 0 ? (
        <Card className="flex items-center justify-center py-12">
          <EmptyStateCard
            icon={CheckSquare}
            title="No tasks found"
            description={archived ? "No archived tasks match your filters." : "Create the first task to get started."}
          />
        </Card>
      ) : view === "table" ? (
        <TasksTable
          projectId={projectId}
          tasks={tasks}
          selected={selected}
          onToggleSelected={toggleSelected}
          canBulkManage={canBulkManage}
        />
      ) : (
        <TasksKanban projectId={projectId} tasks={tasks} authUser={authUser} project={project} />
      )}

      {pagination && pagination.pages > 1 ? (
        <div className="flex items-center justify-between border-t border-border pt-4">
          <p className="text-xs text-muted-foreground">
            Page <span className="font-semibold">{pagination.page}</span> of <span className="font-semibold">{pagination.pages}</span> ·{" "}
            <span className="font-semibold">{pagination.total}</span> tasks
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
      ) : null}
    </div>
  );
}

function AssigneeAvatars({ assignees }) {
  if (!assignees || assignees.length === 0) {
    return <span className="text-sm text-muted-foreground">Unassigned</span>;
  }
  return (
    <AvatarGroup>
      {assignees.slice(0, 3).map((assignee) => (
        <Avatar key={assignee.id} size="sm" title={assignee.fullName} className="ring-2 ring-card">
          <AvatarFallback className="bg-muted text-[11px] font-semibold text-muted-foreground">
            {initials(assignee.fullName)}
          </AvatarFallback>
        </Avatar>
      ))}
      {assignees.length > 3 ? (
        <span className="ml-1 text-xs text-muted-foreground">+{assignees.length - 3}</span>
      ) : null}
    </AvatarGroup>
  );
}

function isOverdue(task) {
  if (!task.dueDate || task.status === "Completed") return false;
  return new Date(task.dueDate) < new Date(new Date().toDateString());
}

function TasksTable({ projectId, tasks, selected, onToggleSelected, canBulkManage }) {
  return (
    <Card className="overflow-hidden rounded-xl border border-border py-0 shadow-sm ring-0">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-border bg-muted/40 hover:bg-muted/40">
            {canBulkManage ? <TableHead className="h-11 w-10 pl-5" /> : null}
            <TableHead className={`h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase ${canBulkManage ? "" : "pl-5"}`}>
              Task
            </TableHead>
            <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Status</TableHead>
            <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Priority</TableHead>
            <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Assignees</TableHead>
            <TableHead className="h-11 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Visibility</TableHead>
            <TableHead className="h-11 pr-5 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase">Due Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => {
            const overdue = isOverdue(task);
            return (
              <TableRow key={task.id} className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/30">
                {canBulkManage ? (
                  <TableCell className="py-3.5 pl-5">
                    <input
                      type="checkbox"
                      checked={selected.includes(task.id)}
                      onChange={() => onToggleSelected(task.id)}
                      onClick={(event) => event.stopPropagation()}
                      className="size-3.5 rounded border-border accent-brand"
                    />
                  </TableCell>
                ) : null}
                <TableCell className={`py-3.5 ${canBulkManage ? "" : "pl-5"}`}>
                  <Link
                    href={`/dashboard/projects/${projectId}/tasks/${task.id}`}
                    className="font-medium text-foreground transition-colors hover:text-brand hover:underline hover:underline-offset-2"
                  >
                    {task.title}
                  </Link>
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
                  <AssigneeAvatars assignees={task.assignees} />
                </TableCell>
                <TableCell className="py-3.5 text-sm text-muted-foreground">{task.visibility}</TableCell>
                <TableCell
                  className={`py-3.5 pr-5 text-right text-xs tabular-nums ${overdue ? "font-medium text-red-600" : "text-muted-foreground"}`}
                >
                  {task.dueDate ? new Date(task.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

const STATUS_DOT_COLORS = {
  Todo: "bg-zinc-400",
  "In Progress": "bg-blue-500",
  "In Review": "bg-amber-500",
  Completed: "bg-emerald-500",
  Cancelled: "bg-red-500",
};

function TasksKanban({ projectId, tasks, authUser, project }) {
  const updateMutation = useUpdateTask(projectId);
  const [dragOverColumn, setDragOverColumn] = useState(null);
  const canDrag = canManageTaskClient(project, authUser);

  const columns = KANBAN_COLUMNS.map((columnStatus) => ({
    status: columnStatus,
    tasks: tasks.filter((task) => task.status === columnStatus),
  }));

  const handleDrop = (targetStatus, event) => {
    event.preventDefault();
    setDragOverColumn(null);
    const taskId = event.dataTransfer.getData("text/task-id");
    const currentStatus = event.dataTransfer.getData("text/task-status");
    if (!taskId || currentStatus === targetStatus) return;

    const allowed = TASK_MANUAL_STATUS_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) return;

    updateMutation.mutate({ taskId, status: targetStatus });
  };

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
      {columns.map((column) => (
        <div
          key={column.status}
          className={`min-w-0 rounded-lg transition-colors ${
            dragOverColumn === column.status ? "bg-brand/5 ring-1 ring-brand/30" : ""
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOverColumn(column.status);
          }}
          onDragLeave={() => setDragOverColumn(null)}
          onDrop={(event) => handleDrop(column.status, event)}
        >
          <div className="mb-3 flex items-center justify-between border-b border-border px-1 pb-2">
            <div className="flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${STATUS_DOT_COLORS[column.status]}`} />
              <span className="text-sm font-semibold text-foreground">{column.status}</span>
            </div>
            <span className="text-xs text-muted-foreground">{column.tasks.length}</span>
          </div>

          <div className="space-y-3">
            {column.tasks.map((task) => (
              <Card
                key={task.id}
                draggable={canDrag}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/task-id", task.id);
                  event.dataTransfer.setData("text/task-status", task.status);
                }}
                className={`group overflow-hidden border-border transition-all duration-300 hover:border-brand/50 hover:shadow-lg ${
                  canDrag ? "cursor-grab active:cursor-grabbing" : ""
                }`}
              >
                <Link href={`/dashboard/projects/${projectId}/tasks/${task.id}`} className="block h-full space-y-3 p-4">
                  <div className="space-y-1">
                    <h4 className="font-semibold text-foreground transition-colors group-hover:text-brand line-clamp-2">
                      {task.title}
                    </h4>
                    {task.description && (
                      <p className="line-clamp-2 text-xs text-muted-foreground">{task.description}</p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge className={`${PRIORITY_STYLES[task.priority]} rounded-full px-2.5 py-0.5 text-xs font-medium`} variant="outline">
                        {task.priority}
                      </Badge>
                      {task.dueDate && (
                        <span className="text-xs text-muted-foreground">
                          {new Date(task.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      )}
                    </div>
                    <AssigneeAvatars assignees={task.assignees} />
                  </div>
                </Link>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
