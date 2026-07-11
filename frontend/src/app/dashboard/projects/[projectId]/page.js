"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Activity, Calendar, CheckSquare, Eye, FileText, File, Image as ImageIcon, AlignLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import KpiStrip from "@/components/dashboard/KpiStrip";
import { useProject } from "@/features/projects/hooks/useProject";
import { useProjectActivity } from "@/features/projects/hooks/useProjectActivity";
import { useProjectResources } from "@/features/projects/hooks/useProjectResources";
import { projectResourceService } from "@/features/projects/services/projectResourceService";
import { useTasks } from "@/features/tasks/hooks/useTasks";
import { STATUS_STYLES, PRIORITY_STYLES } from "@/features/tasks/constants/taskOptions";

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

function formatAction(action) {
  const label = action.replace("project.", "").replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function resourceIcon(mimeType) {
  if (mimeType?.startsWith("image/")) return ImageIcon;
  if (mimeType === "application/pdf" || mimeType === "text/plain") return FileText;
  return File;
}

export default function ProjectOverviewPage() {
  const { projectId } = useParams();
  const { data: projectData, isLoading: isProjectLoading } = useProject(projectId);
  const { data: activityData, isLoading: isActivityLoading } = useProjectActivity(projectId, { limit: 5 });
  const { data: resourcesData, isLoading: isResourcesLoading } = useProjectResources(projectId);
  const { data: tasksData, isLoading: isTasksLoading } = useTasks(projectId, { limit: 5 });

  const project = projectData?.project;
  const activity = activityData?.activity ?? [];
  const recentDocuments = (resourcesData?.resources ?? []).slice(0, 5);
  const recentTasks = tasksData?.tasks ?? [];

  if (isProjectLoading || !project) {
    return (
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Skeleton className="h-64 lg:col-span-2" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const kpiCards = [
    { label: "Start Date", value: formatDate(project.startDate), icon: Calendar, accent: "from-blue-500 to-blue-600" },
    { label: "Due Date", value: formatDate(project.dueDate), icon: Calendar, accent: "from-amber-500 to-amber-600" },
    { label: "Visibility", value: project.visibility, icon: Eye, accent: "from-violet-500 to-violet-600" },
  ];

  return (
    <div className="space-y-6">
      <KpiStrip items={kpiCards} cols={3} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main content - left column */}
        <div className="space-y-6 lg:col-span-2">
          {/* Description */}
          <DashboardCard>
            <DashboardCardHeader
              icon={AlignLeft}
              iconClassName="bg-blue-50 text-blue-600"
              title="Description"
            />
            <div className="mt-4">
              {project.description ? (
                <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-700">{project.description}</p>
              ) : (
                <p className="text-sm text-zinc-400">No description added for this project yet.</p>
              )}
            </div>
          </DashboardCard>

          {/* Recent Tasks */}
          <DashboardCard>
            <DashboardCardHeader
              icon={CheckSquare}
              iconClassName="bg-violet-50 text-violet-600"
              title="Recent tasks"
              description="Latest tasks created in this project"
              action={
                <Link href={`/dashboard/projects/${projectId}/tasks`} className="text-xs font-semibold text-violet-600 hover:underline">
                  View all
                </Link>
              }
            />

            <div className="mt-5">
              {isTasksLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full rounded-xl" />
                  <Skeleton className="h-12 w-full rounded-xl" />
                </div>
              ) : recentTasks.length === 0 ? (
                <EmptyStateCard icon={CheckSquare} title="No tasks yet" description="Tasks created in this project will show up here." />
              ) : (
                <div className="space-y-1">
                  {recentTasks.map((task) => (
                    <Link
                      key={task.id}
                      href={`/dashboard/projects/${projectId}/tasks/${task.id}`}
                      className="flex items-center gap-3 rounded-xl p-2.5 transition-colors hover:bg-zinc-50"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-50 to-violet-100 text-violet-600">
                        <CheckSquare className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-900 hover:underline">{task.title}</p>
                        <p className="text-xs text-zinc-500">{new Date(task.createdAt).toLocaleDateString()}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Badge className={`${STATUS_STYLES[task.status]} font-medium`} variant="outline">
                          {task.status}
                        </Badge>
                        <Badge className={`${PRIORITY_STYLES[task.priority]} font-medium`} variant="outline">
                          {task.priority}
                        </Badge>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </DashboardCard>
        </div>

        {/* Right sidebar */}
        <div className="space-y-6">
          {/* Recent documents */}
          <DashboardCard>
            <DashboardCardHeader
              icon={FileText}
              iconClassName="bg-amber-50 text-amber-600"
              title="Recent documents"
              action={
                <Link href={`/dashboard/projects/${projectId}/resources`} className="text-xs font-semibold text-violet-600 hover:underline">
                  View all
                </Link>
              }
            />

            <div className="mt-5">
              {isResourcesLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full rounded-xl" />
                  <Skeleton className="h-12 w-full rounded-xl" />
                </div>
              ) : recentDocuments.length === 0 ? (
                <EmptyStateCard icon={FileText} title="No documents yet" description="Files shared here will show up." />
              ) : (
                <div className="space-y-1">
                  {recentDocuments.map((resource) => {
                    const Icon = resourceIcon(resource.mimeType);
                    return (
                      <a
                        key={resource.id}
                        href={projectResourceService.downloadUrl(projectId, resource.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-3 rounded-xl p-2.5 transition-colors hover:bg-zinc-50"
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-50 to-amber-100 text-amber-600">
                          <Icon className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-zinc-900 hover:underline">{resource.originalName}</p>
                          <p className="text-xs text-zinc-500">{new Date(resource.createdAt).toLocaleDateString()}</p>
                        </div>
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          </DashboardCard>

          {/* Recent Activity - Improved styling */}
          <DashboardCard>
            <DashboardCardHeader
              icon={Activity}
              iconClassName="bg-emerald-50 text-emerald-600"
              title="Recent activity"
              description="Latest changes on this project"
            />

            <div className="mt-5">
              {isActivityLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <Skeleton key={index} className="h-12 w-full rounded-lg" />
                  ))}
                </div>
              ) : activity.length === 0 ? (
                <EmptyStateCard
                  icon={Activity}
                  title="No activity yet"
                  description="Actions on this project will show up here."
                />
              ) : (
                <div>
                  {activity.map((entry, index) => (
                    <div key={entry._id} className="flex items-stretch gap-3 rounded-xl px-3.5 hover:bg-zinc-50/80 transition-colors">
                      <div className="flex flex-col items-center">
                        <div className="mt-2.5 size-2.5 shrink-0 rounded-full bg-gradient-to-r from-violet-500 to-purple-500" />
                        {index < activity.length - 1 ? <div className="my-1 w-px flex-1 bg-zinc-200" /> : null}
                      </div>
                      <div className="min-w-0 flex-1 pb-4">
                        <p className="text-sm leading-relaxed text-zinc-900">
                          <span className="font-semibold text-zinc-900">{entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : "Someone"}</span>{" "}
                          <span className="text-zinc-600">{formatAction(entry.action).toLowerCase()}</span>
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">{new Date(entry.createdAt).toLocaleString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DashboardCard>
        </div>
      </div>
    </div>
  );
}
