"use client";

import { useRef } from "react";
import { useParams } from "next/navigation";
import { File, FileText, Image as ImageIcon, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { useAuthStore } from "@/store/useAuthStore";
import { useProject } from "@/features/projects/hooks/useProject";
import { useProjectResources } from "@/features/projects/hooks/useProjectResources";
import { useUploadProjectResource } from "@/features/projects/hooks/useUploadProjectResource";
import { useDeleteProjectResource } from "@/features/projects/hooks/useDeleteProjectResource";
import { projectResourceService } from "@/features/projects/services/projectResourceService";
import { canManageProjectClient } from "@/features/projects/utils/permissions";

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

function resourceIcon(mimeType) {
  if (mimeType?.startsWith("image/")) return ImageIcon;
  if (mimeType === "application/pdf" || mimeType === "text/plain") return FileText;
  return File;
}

export default function ProjectResourcesPage() {
  const { projectId } = useParams();
  const authUser = useAuthStore((state) => state.user);
  const { data: projectData } = useProject(projectId);
  const { data, isLoading } = useProjectResources(projectId);
  const uploadMutation = useUploadProjectResource(projectId);
  const deleteMutation = useDeleteProjectResource(projectId);
  const fileInputRef = useRef(null);

  const project = projectData?.project;
  const resources = data?.resources || [];
  const canManage = canManageProjectClient(project, authUser);

  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      uploadMutation.mutate(file);
    }
  };

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={FileText}
        iconClassName="bg-amber-50 text-amber-600"
        title="Resources"
        description="Reference files and images shared with the team."
        action={
          canManage ? (
            <>
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
              <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadMutation.isPending}>
                <Upload className="mr-1.5 size-4" />
                {uploadMutation.isPending ? "Uploading..." : "Upload"}
              </Button>
            </>
          ) : null
        }
      />

      <div className="mt-5">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        ) : resources.length === 0 ? (
          <EmptyStateCard
            icon={FileText}
            title="No resources yet"
            description={canManage ? "Upload a file to get started." : "Files shared here will show up for the team."}
          />
        ) : (
          <div className="space-y-1.5">
            {resources.map((resource) => {
              const Icon = resourceIcon(resource.mimeType);
              return (
                <div
                  key={resource.id}
                  className="flex items-center justify-between gap-3 rounded-xl p-3 transition-colors hover:bg-zinc-50"
                >
                  <a
                    href={projectResourceService.downloadUrl(projectId, resource.id)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-w-0 flex-1 items-center gap-3"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-50 to-amber-100 text-amber-600">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900 hover:underline">
                        {resource.originalName}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {formatSize(resource.size)} · {resource.uploadedBy?.fullName || "Unknown"} ·{" "}
                        {new Date(resource.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </a>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-zinc-400 hover:text-destructive"
                      onClick={() => deleteMutation.mutate(resource.id)}
                      disabled={deleteMutation.isPending}
                      aria-label="Delete resource"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardCard>
  );
}
