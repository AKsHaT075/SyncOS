"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Archive, CheckCircle, Clock, FolderKanban, LayoutGrid, List, Plus, Search, Star, TrendingUp, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import Can from "@/components/auth/Can";
import NewProjectModal from "@/components/projects/NewProjectModal";
import { PERMISSIONS } from "@/constants/permissions";
import { useProjects } from "@/features/projects/hooks/useProjects";
import { useFavoriteProject } from "@/features/projects/hooks/useFavoriteProject";
import {
  PRIORITY_STYLES,
  PROJECT_PRIORITIES,
  PROJECT_STATUSES,
  STATUS_STYLES,
} from "@/features/projects/constants/projectOptions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

const ALL = "all";

export default function ProjectsListPage() {
  const [view, setView] = useState("grid");
  const [searchInput, setSearchInput] = useState("");
  const [status, setStatus] = useState(ALL);
  const [priority, setPriority] = useState(ALL);
  const [archived, setArchived] = useState(false);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);

  const search = useDebouncedValue(searchInput);

  useEffect(() => {
    setPage(1);
  }, [search, status, priority, archived, favoriteOnly]);

  const { data, isLoading, isError } = useProjects({
    page,
    limit: 20,
    ...(search && { search }),
    ...(status !== ALL && { status }),
    ...(priority !== ALL && { priority }),
    archived,
    ...(favoriteOnly && { favorite: true }),
  });
  const favoriteMutation = useFavoriteProject();

  const projects = data?.projects ?? [];
  const pagination = data?.pagination;

  const stats = {
    total: pagination?.total || 0,
    active: projects.filter((p) => p.status !== "Completed").length,
    completed: projects.filter((p) => p.status === "Completed").length,
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-background/95">
      <div className="space-y-6 p-6 max-w-7xl mx-auto">
        {/* Page Header */}
        <div className="space-y-1">
          
          <p className="text-sm text-muted-foreground">Manage and track all your projects</p>
        </div>

        {/* Stats */}
        {!isLoading && !isError && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatsCard icon={TrendingUp} label="Total Projects" value={stats.total} color="from-blue-500/10 to-blue-500/5" />
            <StatsCard icon={Clock} label="In Progress" value={stats.active} color="from-amber-500/10 to-amber-500/5" />
            <StatsCard icon={CheckCircle} label="Completed" value={stats.completed} color="from-green-500/10 to-green-500/5" />
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
                placeholder="Search projects by name..."
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
                  {PROJECT_STATUSES.map((value) => (
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
                  {PROJECT_PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                variant={favoriteOnly ? "secondary" : "outline"}
                size="sm"
                onClick={() => setFavoriteOnly((v) => !v)}
                className="gap-2"
              >
                <Star className={`size-4 ${favoriteOnly ? "fill-amber-400" : ""}`} />
                {favoriteOnly ? "Favorites" : "All"}
              </Button>

              <Button
                variant={archived ? "secondary" : "outline"}
                size="sm"
                onClick={() => setArchived((v) => !v)}
                className="gap-2"
              >
                <Archive className="size-4" />
                {archived ? "Archived" : "Active"}
              </Button>
            </div>

            <Can permission={PERMISSIONS.CREATE_PROJECT}>
              <Button onClick={() => setIsNewProjectOpen(true)} className="gap-2 bg-brand hover:bg-brand/90">
                <Plus className="size-4" /> New Project
              </Button>
            </Can>
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <Card className="flex items-center justify-center py-12">
            <EmptyStateCard
              icon={AlertCircle}
              title="Couldn't load projects"
              description="Please try again in a moment."
            />
          </Card>
        ) : projects.length === 0 ? (
          <Card className="flex items-center justify-center py-12">
            <EmptyStateCard
              icon={FolderKanban}
              title="No projects found"
              description={archived ? "No archived projects match your filters." : "Create your first project to get started."}
            />
          </Card>
        ) : view === "table" ? (
          <ProjectsTable projects={projects} onToggleFavorite={favoriteMutation.mutate} />
        ) : (
          <ProjectsGrid projects={projects} onToggleFavorite={favoriteMutation.mutate} />
        )}

        {/* Pagination */}
        {pagination && pagination.pages > 1 && (
          <div className="flex items-center justify-between border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Page <span className="font-semibold">{pagination.page}</span> of <span className="font-semibold">{pagination.pages}</span> ·
              <span className="font-semibold ml-1">{pagination.total}</span> projects
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

      <NewProjectModal isOpen={isNewProjectOpen} onClose={() => setIsNewProjectOpen(false)} />
    </div>
  );
}

function StatsCard({ icon: Icon, label, value, color }) {
  return (
    <Card className={`overflow-hidden border-0 bg-gradient-to-br ${color}`}>
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold tracking-tight text-foreground">{value}</p>
          </div>
          <Icon className="size-5 text-muted-foreground opacity-60" />
        </div>
      </div>
    </Card>
  );
}


function FavoriteToggle({ project, onToggleFavorite }) {
  return (
    <button
      type="button"
      onClick={() => onToggleFavorite({ projectId: project.id, isFavorite: project.isFavorite })}
      className="rounded-lg p-1.5 hover:bg-background/50 transition-colors"
      aria-label={project.isFavorite ? "Unfavorite project" : "Favorite project"}
    >
      <Star className={`size-4 transition-colors ${project.isFavorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`} />
    </button>
  );
}

function ProjectsTable({ projects, onToggleFavorite }) {
  return (
    <Card className="border-0 overflow-hidden">
      <Table>
        <TableHeader className="bg-card/50 border-b border-border">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10 text-center">
              <Star className="size-4 opacity-30 mx-auto" />
            </TableHead>
            <TableHead className="font-semibold">Project</TableHead>
            <TableHead className="font-semibold">Status</TableHead>
            <TableHead className="font-semibold">Priority</TableHead>
            <TableHead className="font-semibold text-center">Members</TableHead>
            <TableHead className="font-semibold">Due Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => (
            <TableRow key={project.id} className="hover:bg-card/50 transition-colors border-b border-border/50">
              <TableCell className="text-center">
                <FavoriteToggle project={project} onToggleFavorite={onToggleFavorite} />
              </TableCell>
              <TableCell>
                <Link href={`/dashboard/projects/${project.id}`} className="font-medium text-foreground hover:text-brand transition-colors">
                  {project.name}
                </Link>
              </TableCell>
              <TableCell>
                <Badge className={`${STATUS_STYLES[project.status]} font-medium`} variant="outline">
                  {project.status}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge className={`${PRIORITY_STYLES[project.priority]} font-medium`} variant="outline">
                  {project.priority}
                </Badge>
              </TableCell>
              <TableCell className="text-center text-sm font-medium text-foreground">{project.memberCount}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {project.dueDate ? new Date(project.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function ProjectsGrid({ projects, onToggleFavorite }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <Card key={project.id} className="group overflow-hidden border-border hover:border-brand/50 hover:shadow-lg transition-all duration-300 cursor-pointer">
          <Link href={`/dashboard/projects/${project.id}`} className="block h-full p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 space-y-1 min-w-0">
                <h3 className="font-semibold text-foreground group-hover:text-brand transition-colors truncate">
                  {project.name}
                </h3>
                {project.description && (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{project.description}</p>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleFavorite({ projectId: project.id, isFavorite: project.isFavorite });
                }}
                className="rounded-lg p-1.5 hover:bg-background/50 transition-colors flex-shrink-0"
              >
                <Star className={`size-4 transition-colors ${project.isFavorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`} />
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-brand/50" />
                {project.memberCount} member{project.memberCount !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/50">
              <Badge className={`${STATUS_STYLES[project.status]} font-medium text-xs`} variant="outline">
                {project.status}
              </Badge>
              <Badge className={`${PRIORITY_STYLES[project.priority]} font-medium text-xs`} variant="outline">
                {project.priority}
              </Badge>
              {project.dueDate && (
                <span className="text-xs text-muted-foreground ml-auto">
                  Due {new Date(project.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
              )}
            </div>
          </Link>
        </Card>
      ))}
    </div>
  );
}
