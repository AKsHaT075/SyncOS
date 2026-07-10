"use client";

import Link from "next/link";
import { FolderKanban, ArrowUpRight, Pin } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import { MOCK_PROJECTS } from "@/components/dashboard/mockDashboardData";

const STATUS_STYLES = {
  "on track": "bg-emerald-50 text-emerald-700",
  "at risk": "bg-amber-50 text-amber-700",
  blocked: "bg-red-50 text-red-700",
  done: "bg-zinc-100 text-zinc-600",
};

const PRIORITY_STYLES = {
  high: "bg-red-50 text-red-700",
  medium: "bg-amber-50 text-amber-700",
  low: "bg-zinc-100 text-zinc-600",
};

function initials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function ProjectsOverviewCard({ projects = MOCK_PROJECTS, rowLimit = 5 }) {
  const visible = projects.slice(0, rowLimit);
  const activeCount = projects.filter((project) => project.status !== "done").length;

  return (
    <div className="rounded-2xl border border-zinc-200/70 bg-white p-5 shadow-sm">
      <DashboardCardHeader
        icon={FolderKanban}
        iconClassName="bg-violet-50 text-violet-600"
        title="Projects"
        description={`${activeCount} active`}
        preview
        action={
          <Link
            href="/dashboard/projects"
            className="flex shrink-0 items-center gap-1 text-xs font-semibold text-violet-600 hover:text-violet-700"
          >
            View all
            <ArrowUpRight className="size-3.5" />
          </Link>
        }
      />

      <div className="mt-3">
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-100">
              <TableHead className="text-xs text-zinc-500">Project</TableHead>
              <TableHead className="text-xs text-zinc-500">Status</TableHead>
              <TableHead className="text-xs text-zinc-500">Priority</TableHead>
              <TableHead className="text-xs text-zinc-500">Owner</TableHead>
              <TableHead className="text-xs text-zinc-500">Due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((project) => (
              <TableRow key={project.id} className="border-zinc-100">
                <TableCell className="text-sm font-medium text-zinc-900">
                  <span className="flex items-center gap-1.5">
                    {project.pinned && <Pin className="size-3 shrink-0 text-violet-500" />}
                    {project.name}
                  </span>
                </TableCell>
                <TableCell>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_STYLES[project.status]}`}
                  >
                    {project.status}
                  </span>
                </TableCell>
                <TableCell>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${PRIORITY_STYLES[project.priority]}`}>
                    {project.priority}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Avatar size="sm">
                      <AvatarFallback>{initials(project.owner)}</AvatarFallback>
                    </Avatar>
                    <span className="text-xs text-zinc-600">{project.owner}</span>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-zinc-500">{project.due}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
