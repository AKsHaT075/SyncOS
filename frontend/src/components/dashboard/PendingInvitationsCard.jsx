import { Mail, Send } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

function formatRelativeTime(dateInput) {
  const date = new Date(dateInput);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export default function PendingInvitationsCard({ invitations, isLoading, onResend, isResending, preview = false }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Mail}
        iconClassName="bg-amber-50 text-amber-600"
        title="Pending invitations"
        description="Awaiting a response from your team."
      />

      <div className="mt-5 space-y-1">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-zinc-400">Loading…</p>
        ) : !invitations || invitations.length === 0 ? (
          <EmptyStateCard
            icon={Mail}
            title="No pending invites"
            description="Invite a teammate to get your workspace going."
          />
        ) : (
          invitations.map((invitation) => (
            <div
              key={invitation.id}
              className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-zinc-50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-900">{invitation.email}</p>
                <p className="text-xs capitalize text-zinc-500">
                  {invitation.role} · invited {formatRelativeTime(invitation.createdAt)}
                </p>
              </div>
              {onResend && (
                <button
                  type="button"
                  onClick={() => onResend(invitation.id)}
                  disabled={isResending}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50"
                >
                  <Send className="size-3" />
                  Resend
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </DashboardCard>
  );
}
