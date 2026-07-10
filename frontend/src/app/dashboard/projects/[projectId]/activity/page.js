"use client";

import React, { useState } from "react";
import { useParams } from "next/navigation";
import { Activity, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { useProjectActivity } from "@/features/projects/hooks/useProjectActivity";

const ACTION_LABELS = {
  "project.created": "Created project",
  "project.updated": "Updated project",
  "project.archived": "Archived project",
  "project.restored": "Restored project",
  "project.status_changed": "Changed status",
  "project.priority_changed": "Changed priority",
  "project.member_added": "Added member",
  "project.member_removed": "Removed member",
  "project.member_role_changed": "Changed member role",
  "project.ownership_transferred": "Transferred ownership",
  "project.resource_uploaded": "Uploaded resource",
  "project.resource_deleted": "Deleted resource",
};

function formatDate(date) {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

export default function ProjectActivityPage() {
  const { projectId } = useParams();
  const [page, setPage] = useState(1);
  const { data, isLoading } = useProjectActivity(projectId, { page, limit: 20 });

  const activity = data?.activity || [];
  const pagination = data?.pagination;

  if (isLoading) {
    return (
      <DashboardCard>
        <div className="space-y-3">
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      </DashboardCard>
    );
  }

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Activity}
        iconClassName="bg-emerald-50 text-emerald-600"
        title="Activity"
        description="Project changes and events over time."
      />

      <div className="mt-5">
        {activity.length === 0 ? (
          <EmptyStateCard icon={Activity} title="No activity yet" description="Actions on this project will show up here." />
        ) : (
          <div className="space-y-1.5">
            {activity.map((log) => (
              <div key={log._id} className="flex items-start gap-3 rounded-xl p-3.5 transition-colors hover:bg-zinc-50/80">
                <div className="mt-1.5 size-2.5 shrink-0 rounded-full bg-gradient-to-r from-violet-500 to-purple-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-relaxed text-zinc-900">
                    {log.user ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help font-semibold text-zinc-900 border-b border-dotted border-zinc-400 hover:border-zinc-600">
                            {`${log.user.firstName} ${log.user.lastName}`.trim()}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          {log.user.email}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="font-semibold text-zinc-900">Unknown user</span>
                    )}{" "}
                    <span className="text-zinc-600">{ACTION_LABELS[log.action] || log.action}</span>
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
                    <Calendar className="size-3" />
                    {formatDate(log.createdAt)}
                  </p>
                  {log.metadata && Object.keys(log.metadata).length > 0 ? (
                    <p className="mt-1 text-xs text-zinc-500">
                      {Object.entries(log.metadata)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(", ")}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}

            {pagination && pagination.pages > 1 ? (
              <div className="flex items-center justify-center gap-2 pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  Previous
                </Button>
                <span className="text-xs text-zinc-500">
                  Page {page} of {pagination.pages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
                  disabled={page === pagination.pages}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </DashboardCard>
  );
}
