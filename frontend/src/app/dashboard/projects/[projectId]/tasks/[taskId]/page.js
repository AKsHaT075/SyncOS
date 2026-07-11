"use client";

import { useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  Archive,
  ArchiveRestore,
  AlertTriangle,
  CheckCircle2,
  MessageSquareText,
  Paperclip,
  History,
  Reply,
  Send,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarGroup } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { useAuthStore } from "@/store/useAuthStore";
import { useProject } from "@/features/projects/hooks/useProject";
import { useTask } from "@/features/tasks/hooks/useTask";
import { useUpdateTask } from "@/features/tasks/hooks/useUpdateTask";
import { useArchiveTask } from "@/features/tasks/hooks/useArchiveTask";
import { useUnarchiveTask } from "@/features/tasks/hooks/useUnarchiveTask";
import { useSubmitTask } from "@/features/tasks/hooks/useSubmitTask";
import { useReviewTask } from "@/features/tasks/hooks/useReviewTask";
import { useTaskActivity } from "@/features/tasks/hooks/useTaskActivity";
import { useUploadTaskAttachment, useDeleteTaskAttachment } from "@/features/tasks/hooks/useTaskAttachments";
import { taskService } from "@/features/tasks/services/taskService";
import { submitForReviewSchema, reviewTaskSchema } from "@/features/tasks/schemas/taskSchemas";
import {
  PRIORITY_STYLES,
  STATUS_STYLES,
  TASK_MANUAL_STATUS_TRANSITIONS,
  TASK_REVIEW_ACTIONS,
  TASK_STATUSES,
  VISIBILITY_STYLES,
} from "@/features/tasks/constants/taskOptions";
import {
  canApproveTaskClient,
  canManageTaskClient,
  canSubmitForReviewClient,
} from "@/features/tasks/utils/permissions";
import { getProjectPeople } from "@/features/tasks/utils/projectPeople";

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function TaskDetailPage() {
  const { projectId, taskId } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const authUser = useAuthStore((state) => state.user);
  const { data: projectData } = useProject(projectId);
  const { data: taskData, isLoading } = useTask(projectId, taskId);
  const project = projectData?.project;
  const task = taskData?.task;

  const updateMutation = useUpdateTask(projectId);
  const archiveMutation = useArchiveTask(projectId);
  const unarchiveMutation = useUnarchiveTask(projectId);

  const [submitOpen, setSubmitOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

  const activeTab = searchParams.get("tab") || "overview";
  const handleTabChange = (value) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "overview") {
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    const query = params.toString();
    router.replace(`/dashboard/projects/${projectId}/tasks/${taskId}${query ? `?${query}` : ""}`, { scroll: false });
  };

  if (isLoading || !task) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  const canManage = canManageTaskClient(project, authUser);
  // Only assignee-facing submission is blocked while archived — managers can
  // still change status, reply to updates, and unarchive at any time.
  const canSubmit = canSubmitForReviewClient(task, authUser) && !task.archived;
  const canApprove = canApproveTaskClient(project, task, authUser) && task.status === "In Review";
  const allowedNextStatuses = TASK_MANUAL_STATUS_TRANSITIONS[task.status] || [];

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-col gap-3 rounded-2xl border border-zinc-200/70 bg-white p-5 shadow-sm sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-xl font-semibold text-zinc-900">{task.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={`${STATUS_STYLES[task.status]} font-medium`} variant="outline">
              {task.status}
            </Badge>
            <Badge className={`${PRIORITY_STYLES[task.priority]} font-medium`} variant="outline">
              {task.priority}
            </Badge>
            <Badge className={`${VISIBILITY_STYLES[task.visibility]} font-medium`} variant="outline">
              {task.visibility}
            </Badge>
            {task.archived ? (
              <Badge variant="secondary" className="font-medium">
                Archived
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canManage && allowedNextStatuses.length > 0 ? (
            <Select
              value={task.status}
              onValueChange={(status) => {
                if (status !== task.status) updateMutation.mutate({ taskId, status });
              }}
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TASK_STATUSES.filter((value) => value === task.status || allowedNextStatuses.includes(value)).map(
                  (value) => (
                    <SelectItem key={value} value={value} disabled={value === task.status}>
                      {value}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          ) : null}

          {canSubmit ? (
            <Button
              size="lg"
              onClick={() => setSubmitOpen(true)}
              className="gap-2 bg-brand font-semibold shadow-md shadow-brand/20 hover:bg-brand/90"
            >
              <Send className="size-4" /> {task.status === "In Review" ? "Submit New Update" : "Submit for Review"}
            </Button>
          ) : null}

          {canManage && !task.archived ? (
            <Button
              size="lg"
              variant="outline"
              onClick={() => setArchiveConfirmOpen(true)}
              className="gap-2 font-semibold text-zinc-700"
            >
              <Archive className="size-4" /> Archive Task
            </Button>
          ) : null}

          {canManage && task.archived ? (
            <Button
              size="lg"
              variant="outline"
              onClick={() => unarchiveMutation.mutate(taskId)}
              disabled={unarchiveMutation.isPending}
              className="gap-2 font-semibold text-zinc-700"
            >
              <ArchiveRestore className="size-4" />
              {unarchiveMutation.isPending ? "Unarchiving..." : "Unarchive Task"}
            </Button>
          ) : null}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="attachments">Attachments</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab task={task} canApprove={canApprove} onReply={setReviewTarget} />
        </TabsContent>
        <TabsContent value="attachments" className="mt-4">
          <AttachmentsTab projectId={projectId} taskId={taskId} task={task} canManage={canManage} authUser={authUser} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityTab projectId={projectId} taskId={taskId} />
        </TabsContent>
        <TabsContent value="members" className="mt-4">
          <MembersTab projectId={projectId} taskId={taskId} task={task} project={project} canManage={canManage} />
        </TabsContent>
      </Tabs>

      <SubmitForReviewDialog
        projectId={projectId}
        taskId={taskId}
        isResubmission={task.status === "In Review"}
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
      />
      <ReviewTaskDialog
        projectId={projectId}
        taskId={taskId}
        submission={reviewTarget}
        open={Boolean(reviewTarget)}
        onClose={() => setReviewTarget(null)}
      />
      <ArchiveTaskDialog
        open={archiveConfirmOpen}
        onClose={() => setArchiveConfirmOpen(false)}
        isPending={archiveMutation.isPending}
        onConfirm={() => {
          archiveMutation.mutate(taskId, { onSuccess: () => setArchiveConfirmOpen(false) });
        }}
      />
    </div>
  );
}

const REVIEW_ACTION_STYLES = {
  Approved: { icon: CheckCircle2, dot: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-700" },
  Rejected: { icon: XCircle, dot: "bg-red-500", badge: "bg-red-50 text-red-700" },
  "Changes Requested": { icon: AlertTriangle, dot: "bg-amber-500", badge: "bg-amber-50 text-amber-700" },
};

function ReviewReplyCard({ review }) {
  const style = REVIEW_ACTION_STYLES[review.action] || REVIEW_ACTION_STYLES.Approved;
  const ActionIcon = style.icon;
  return (
    <div className="rounded-xl border border-zinc-200/70 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${style.dot} text-white`}>
            <ActionIcon className="size-3" />
          </span>
          <span className="text-sm font-semibold text-zinc-900">{review.reviewer?.fullName || "Unknown"}</span>
          <Badge className={`${style.badge} font-medium`} variant="outline">
            {review.action}
          </Badge>
        </div>
        <span className="text-xs text-zinc-500">{formatDateTime(review.reviewedAt)}</span>
      </div>
      {review.remarks ? <p className="mt-2 pl-7 text-sm whitespace-pre-wrap text-zinc-700">{review.remarks}</p> : null}
    </div>
  );
}

function OverviewTab({ task, canApprove, onReply }) {
  const submissions = task.submissions || [];
  const latestSubmissionId = submissions.length > 0 ? submissions[submissions.length - 1].id : null;

  const reviewsBySubmission = new Map();
  const unlinkedReviews = [];
  task.reviews.forEach((review) => {
    const belongsToKnownSubmission = review.submissionId && submissions.some((s) => s.id === review.submissionId);
    if (belongsToKnownSubmission) {
      if (!reviewsBySubmission.has(review.submissionId)) reviewsBySubmission.set(review.submissionId, []);
      reviewsBySubmission.get(review.submissionId).push(review);
    } else {
      unlinkedReviews.push(review);
    }
  });

  const hasTimeline = submissions.length > 0 || unlinkedReviews.length > 0;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <DashboardCard>
          <DashboardCardHeader title="Description" />
          <p className="mt-3 text-sm whitespace-pre-wrap text-zinc-700">{task.description || "No description provided."}</p>
        </DashboardCard>

        <DashboardCard>
          <DashboardCardHeader
            icon={MessageSquareText}
            iconClassName="bg-blue-50 text-blue-600"
            title="Submission & Review"
            description="Each submission, and every reviewer reply tied to it."
          />

          {!hasTimeline ? (
            <div className="mt-4">
              <EmptyStateCard
                icon={MessageSquareText}
                title="No submission yet"
                description="Once this task is submitted for review, the submission and every reviewer reply will show up here."
              />
            </div>
          ) : (
            <div className="mt-4 space-y-6">
              {submissions.map((submission, index) => {
                const replies = (reviewsBySubmission.get(submission.id) || []).sort(
                  (a, b) => new Date(a.reviewedAt) - new Date(b.reviewedAt)
                );
                const isLatest = submission.id === latestSubmissionId;
                return (
                  <div key={submission.id} className="space-y-3">
                    <div className="rounded-xl border border-zinc-200/70 bg-zinc-50/60 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white">
                            <Send className="size-3" />
                          </span>
                          <p className="text-sm font-semibold text-zinc-900">
                            {submissions.length > 1 ? `Submission ${index + 1} — ` : ""}
                            {submission.submittedBy?.fullName || "Unknown"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-zinc-500">{formatDateTime(submission.submittedAt)}</span>
                          {canApprove && isLatest ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => onReply(submission)}
                              className="h-7 gap-1.5 px-2 text-xs text-brand hover:bg-brand/10 hover:text-brand"
                              title="Reply to this update"
                            >
                              <Reply className="size-3.5" /> Reply
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-2 pl-7 text-sm whitespace-pre-wrap text-zinc-700">{submission.description}</p>
                      {submission.attachments.length > 0 ? (
                        <ul className="mt-3 flex flex-wrap gap-2 pl-7">
                          {submission.attachments.map((attachment) => (
                            <li
                              key={attachment.id}
                              className="flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-600"
                            >
                              <Paperclip className="size-3 shrink-0" />
                              <span className="max-w-[10rem] truncate">{attachment.originalName}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>

                    {replies.length > 0 ? (
                      <div className="ml-6 space-y-2.5 border-l-2 border-zinc-100 pl-4">
                        {replies.map((review) => (
                          <ReviewReplyCard key={review.id} review={review} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}

              {unlinkedReviews.length > 0 ? (
                <div className="space-y-2.5">
                  {submissions.length > 0 ? <p className="text-xs font-medium text-zinc-500">Other replies</p> : null}
                  {unlinkedReviews.map((review) => (
                    <ReviewReplyCard key={review.id} review={review} />
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </DashboardCard>
      </div>

      <div className="space-y-4">
        <DashboardCard>
          <DashboardCardHeader title="Details" />
          <dl className="mt-3 space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-zinc-500">Owner</dt>
              <dd className="font-medium text-zinc-900">{task.owner?.fullName || "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-zinc-500">Start date</dt>
              <dd className="font-medium text-zinc-900">{formatDate(task.startDate)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-zinc-500">Due date</dt>
              <dd className="font-medium text-zinc-900">{formatDate(task.dueDate)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-zinc-500">Estimated hours</dt>
              <dd className="font-medium text-zinc-900">{task.estimatedHours ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-zinc-500">Completed</dt>
              <dd className="font-medium text-zinc-900">{formatDate(task.completedAt)}</dd>
            </div>
          </dl>
        </DashboardCard>

        <DashboardCard>
          <DashboardCardHeader title="Assignees" />
          {task.assignees.length === 0 ? (
            <p className="mt-3 text-xs text-zinc-500">No assignees yet.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {task.assignees.map((assignee) => (
                <div key={assignee.id} className="flex items-center gap-2">
                  <Avatar size="sm">
                    <AvatarFallback>{initials(assignee.fullName)}</AvatarFallback>
                  </Avatar>
                  <span className="text-sm text-zinc-800">{assignee.fullName}</span>
                </div>
              ))}
            </div>
          )}
        </DashboardCard>

        <DashboardCard>
          <DashboardCardHeader title="Approvers" />
          {task.approvers.length === 0 ? (
            <p className="mt-3 text-xs text-zinc-500">
              No explicit approvers — any project Owner/Manager can review.
            </p>
          ) : (
            <div className="mt-3 flex items-center gap-1">
              <AvatarGroup>
                {task.approvers.map((approver) => (
                  <Avatar key={approver.id} size="sm" title={approver.fullName}>
                    <AvatarFallback>{initials(approver.fullName)}</AvatarFallback>
                  </Avatar>
                ))}
              </AvatarGroup>
            </div>
          )}
        </DashboardCard>

        {task.labels.length > 0 || task.tags.length > 0 ? (
          <DashboardCard>
            <DashboardCardHeader title="Labels & Tags" />
            <div className="mt-3 flex flex-wrap gap-1.5">
              {task.labels.map((label) => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))}
              {task.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  #{tag}
                </Badge>
              ))}
            </div>
          </DashboardCard>
        ) : null}
      </div>
    </div>
  );
}

function AttachmentsTab({ projectId, taskId, task, canManage, authUser }) {
  const uploadMutation = useUploadTaskAttachment(projectId, taskId);
  const deleteMutation = useDeleteTaskAttachment(projectId, taskId);

  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    if (file) uploadMutation.mutate(file);
    event.target.value = "";
  };

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Paperclip}
        title="Attachments"
        description={`${task.attachments.length} file${task.attachments.length !== 1 ? "s" : ""}`}
        action={
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50">
            <Upload className="size-4" /> Upload
            <input type="file" className="hidden" onChange={handleFileChange} />
          </label>
        }
      />

      {task.attachments.length === 0 ? (
        <div className="mt-4">
          <EmptyStateCard icon={Paperclip} title="No attachments" description="Files shared on this task will show up here." />
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {task.attachments.map((attachment) => {
            const canDelete = canManage || attachment.uploadedBy?.id === authUser?.id;
            return (
              <div key={attachment.id} className="flex items-center justify-between rounded-lg border border-zinc-100 p-3">
                <a
                  href={taskService.attachmentDownloadUrl(projectId, taskId, attachment.id)}
                  className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800 hover:text-brand"
                >
                  {attachment.originalName}
                </a>
                <div className="flex items-center gap-3 pl-3">
                  <span className="text-xs text-zinc-500">{(attachment.size / 1024).toFixed(1)} KB</span>
                  {canDelete ? (
                    <button
                      type="button"
                      onClick={() => deleteMutation.mutate(attachment.id)}
                      className="text-zinc-400 hover:text-destructive"
                      aria-label="Delete attachment"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </DashboardCard>
  );
}

function ActivityTab({ projectId, taskId }) {
  const { data, isLoading } = useTaskActivity(projectId, taskId);
  const activity = data?.activity ?? [];

  return (
    <DashboardCard>
      <DashboardCardHeader icon={History} title="Activity" description="Everything that has happened on this task." />
      {isLoading ? (
        <Skeleton className="mt-4 h-32 w-full rounded-lg" />
      ) : activity.length === 0 ? (
        <div className="mt-4">
          <EmptyStateCard icon={History} title="No activity yet" />
        </div>
      ) : (
        <ul className="mt-4 space-y-3 border-l border-zinc-200 pl-4">
          {activity.map((entry) => (
            <li key={entry._id} className="relative">
              <span className="absolute -left-[21px] top-1 size-2 rounded-full bg-zinc-300" />
              <p className="text-sm text-zinc-800">
                <span className="font-medium">{entry.user?.firstName ? `${entry.user.firstName} ${entry.user.lastName}` : "System"}</span>{" "}
                <span className="text-zinc-500">{entry.action.replace("task.", "").replace(/_/g, " ")}</span>
              </p>
              <p className="text-xs text-zinc-400">{formatDateTime(entry.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </DashboardCard>
  );
}

// Assignees/approvers can only ever be project members (or the project
// owner) — enforced server-side by assertUsersInProject in task.service.js
// — so "add" only ever offers people already on the project, and adding
// someone new to the task never has to touch project membership itself.
function MembersTab({ projectId, taskId, task, project, canManage }) {
  const updateMutation = useUpdateTask(projectId);
  const people = getProjectPeople(project);

  const setAssignees = (nextIds) => updateMutation.mutate({ taskId, assignees: nextIds });
  const setApprovers = (nextIds) => updateMutation.mutate({ taskId, approvers: nextIds });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <MemberGroupCard
        title="Assignees"
        description="People doing the work on this task."
        people={people}
        selectedIds={task.assignees.map((assignee) => assignee.id)}
        selectedPeople={task.assignees}
        canManage={canManage}
        isPending={updateMutation.isPending}
        onChange={setAssignees}
      />
      <MemberGroupCard
        title="Approvers"
        description="Explicitly chosen reviewers — project Owners/Managers can always approve too."
        people={people}
        selectedIds={task.approvers.map((approver) => approver.id)}
        selectedPeople={task.approvers}
        canManage={canManage}
        isPending={updateMutation.isPending}
        onChange={setApprovers}
      />
    </div>
  );
}

function MemberGroupCard({ title, description, people, selectedIds, selectedPeople, canManage, isPending, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const candidates = people.filter(
    (person) => !selectedIds.includes(person.id) && person.fullName?.toLowerCase().includes(search.toLowerCase())
  );

  const handleAdd = (personId) => {
    onChange([...selectedIds, personId]);
    setOpen(false);
    setSearch("");
  };

  const handleRemove = (personId) => {
    onChange(selectedIds.filter((id) => id !== personId));
  };

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Users}
        title={title}
        description={description}
        action={
          canManage ? (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" disabled={isPending}>
                  <UserPlus className="mr-1.5 size-4" /> Add
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72">
                <Input
                  placeholder="Search project members..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  autoFocus
                />
                <div className="mt-1 max-h-56 space-y-0.5 overflow-y-auto">
                  {candidates.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">No matching project members.</p>
                  ) : (
                    candidates.map((person) => (
                      <button
                        key={person.id}
                        type="button"
                        onClick={() => handleAdd(person.id)}
                        className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-accent"
                      >
                        <Avatar size="sm">
                          <AvatarFallback>{initials(person.fullName)}</AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">{person.fullName}</span>
                          <span className="block truncate text-xs text-muted-foreground">{person.role}</span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>
          ) : null
        }
      />

      {selectedPeople.length === 0 ? (
        <div className="mt-4">
          <EmptyStateCard icon={Users} title={`No ${title.toLowerCase()} yet`} />
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {selectedPeople.map((person) => (
            <div key={person.id} className="flex items-center justify-between gap-3 rounded-xl p-2.5 hover:bg-zinc-50">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar size="sm">
                  <AvatarFallback>{initials(person.fullName)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-900">{person.fullName || "Unknown"}</p>
                  <p className="truncate text-xs text-zinc-500">{person.email}</p>
                </div>
              </div>
              {canManage ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-zinc-400 hover:text-destructive"
                  onClick={() => handleRemove(person.id)}
                  disabled={isPending}
                  aria-label={`Remove ${person.fullName}`}
                >
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </DashboardCard>
  );
}

function SubmitForReviewDialog({ projectId, taskId, isResubmission, open, onClose }) {
  const mutation = useSubmitTask(projectId, taskId);
  const [files, setFiles] = useState([]);
  const form = useForm({ defaultValues: { description: "" }, resolver: zodResolver(submitForReviewSchema) });

  const onSubmit = async (values) => {
    try {
      await mutation.mutateAsync({ description: values.description, files });
      form.reset();
      setFiles([]);
      onClose();
    } catch (error) {
      // toast handled in hook
    }
  };

  const removeFile = (index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          form.reset();
          setFiles([]);
          onClose();
        }
      }}
    >
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="gap-3 p-6 pb-4">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Send className="size-5" />
            </span>
            <div>
              <DialogTitle className="text-base">{isResubmission ? "Submit New Update" : "Submit for Review"}</DialogTitle>
              <DialogDescription>
                {isResubmission
                  ? "This task is already In Review — add a new update alongside your previous submission. Nothing you submitted before is lost."
                  : "Describe what you completed. This moves the task to In Review."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)}>
          <div className="space-y-4 px-6 pb-6">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600">What did you complete?</label>
              <Textarea
                placeholder="Summarize the work you're submitting..."
                {...form.register("description")}
                className="min-h-28 text-sm"
              />
              {form.formState.errors.description ? (
                <p className="text-xs text-destructive">{form.formState.errors.description.message}</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600">Attachments (optional)</label>
              <label className="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50/50 px-4 py-6 text-center transition-colors hover:border-brand/40 hover:bg-brand/5">
                <Upload className="size-5 text-zinc-400" />
                <span className="text-sm font-medium text-zinc-700">Click to upload files</span>
                <span className="text-xs text-zinc-400">or drag and drop</span>
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => setFiles((prev) => [...prev, ...Array.from(event.target.files || [])])}
                />
              </label>

              {files.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {files.map((file, index) => (
                    <li
                      key={`${file.name}-${index}`}
                      className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5"
                    >
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-700">
                        <Paperclip className="size-3.5 shrink-0 text-zinc-400" />
                        <span className="truncate">{file.name}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFile(index)}
                        className="shrink-0 text-zinc-400 hover:text-destructive"
                        aria-label={`Remove ${file.name}`}
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>

          <DialogFooter className="-mx-0 -mb-0 rounded-b-xl">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending} className="gap-2 bg-brand hover:bg-brand/90">
              <Send className="size-4" />
              {mutation.isPending ? "Submitting..." : isResubmission ? "Submit Update" : "Submit for Review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReviewTaskDialog({ projectId, taskId, submission, open, onClose }) {
  const mutation = useReviewTask(projectId, taskId);
  const form = useForm({
    defaultValues: { action: "Approved", remarks: "" },
    resolver: zodResolver(reviewTaskSchema),
  });

  const onSubmit = async (values) => {
    try {
      await mutation.mutateAsync({
        action: values.action,
        remarks: values.remarks || undefined,
        submissionId: submission?.id,
      });
      form.reset();
      onClose();
    } catch (error) {
      // toast handled in hook
    }
  };

  const selectedAction = form.watch("action");
  const selectedStyle = REVIEW_ACTION_STYLES[selectedAction];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          form.reset();
          onClose();
        }
      }}
    >
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="gap-3 p-6 pb-4">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600">
              <Reply className="size-5" />
            </span>
            <div>
              <DialogTitle className="text-base">Reply to Update</DialogTitle>
              <DialogDescription>
                {submission
                  ? `Replying to the update from ${submission.submittedBy?.fullName || "Unknown"} on ${formatDateTime(submission.submittedAt)}.`
                  : "Approve, reject, or request changes on this submission."}
              </DialogDescription>
            </div>
          </div>
          {submission ? (
            <div className="rounded-lg border border-zinc-200/70 bg-zinc-50/60 p-3">
              <p className="line-clamp-3 text-xs whitespace-pre-wrap text-zinc-600">{submission.description}</p>
            </div>
          ) : null}
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)}>
          <div className="space-y-4 px-6 pb-6">
            <div className="grid grid-cols-3 gap-2">
              {TASK_REVIEW_ACTIONS.map((action) => {
                const style = REVIEW_ACTION_STYLES[action];
                const ActionIcon = style.icon;
                const isSelected = selectedAction === action;
                return (
                  <label
                    key={action}
                    className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border p-3 text-center text-xs font-medium transition-colors ${
                      isSelected ? "border-brand bg-brand/5 text-brand" : "border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                    }`}
                  >
                    <input type="radio" value={action} {...form.register("action")} className="hidden" />
                    <ActionIcon className={`size-4 ${isSelected ? "text-brand" : "text-zinc-400"}`} />
                    {action}
                  </label>
                );
              })}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-600">Remarks {selectedAction === "Approved" ? "(optional)" : ""}</label>
              <Textarea
                placeholder="Add a reply for the assignee..."
                {...form.register("remarks")}
                className="min-h-24 text-sm"
              />
              {form.formState.errors.remarks ? (
                <p className="text-xs text-destructive">{form.formState.errors.remarks.message}</p>
              ) : null}
            </div>
          </div>

          <DialogFooter className="-mx-0 -mb-0 rounded-b-xl">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending}
              className={`gap-2 ${selectedStyle?.dot || ""} hover:opacity-90`}
            >
              {mutation.isPending ? "Saving..." : `Submit: ${selectedAction}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveTaskDialog({ open, onClose, onConfirm, isPending }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="gap-3 p-6 pb-4">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
              <Archive className="size-5" />
            </span>
            <div>
              <DialogTitle className="text-base">Archive this task?</DialogTitle>
              <DialogDescription>Here&apos;s what changes once it&apos;s archived.</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-2 px-6 pb-6">
          <ul className="space-y-2 text-sm text-zinc-700">
            <li className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-400" />
              It's hidden from the active task list by default, but nothing is deleted — you can find it again with the Archived filter.
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-400" />
              Assignees can no longer submit updates while it's archived.
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-400" />
              Managers can still change status, reply to updates, and unarchive it — anytime, no restrictions.
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-400" />
              All submissions, replies, and activity history stay exactly as they are.
            </li>
          </ul>
        </div>

        <DialogFooter className="-mx-0 -mb-0 rounded-b-xl">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="gap-2 bg-amber-600 hover:bg-amber-700"
          >
            <Archive className="size-4" />
            {isPending ? "Archiving..." : "Archive Task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
