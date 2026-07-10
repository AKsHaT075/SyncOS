import { UserPlus2 } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

function initials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function RecentlyJoinedMembersCard({ members, title = "Recently joined" }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={UserPlus2}
        iconClassName="bg-violet-50 text-violet-600"
        title={title}
        description="New teammates this month."
        preview
      />

      <div className="mt-4 space-y-1">
        {members.length === 0 ? (
          <EmptyStateCard icon={UserPlus2} title="No new members yet" />
        ) : (
          members.map((member) => (
            <div key={member.id} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-zinc-50">
              <Avatar size="sm">
                <AvatarFallback>{initials(member.name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-900">{member.name}</p>
                <p className="text-xs capitalize text-zinc-500">{member.role}</p>
              </div>
              <span className="shrink-0 text-xs text-zinc-400">{member.joinedAt}</span>
            </div>
          ))
        )}
      </div>
    </DashboardCard>
  );
}
