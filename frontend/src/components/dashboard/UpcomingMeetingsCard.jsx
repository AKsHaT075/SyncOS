import { CalendarClock, Video } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

const GROUP_LABELS = {
  today: "Today",
  tomorrow: "Tomorrow",
  upcoming: "Upcoming",
};

export default function UpcomingMeetingsCard({ meetings }) {
  const groups = ["today", "tomorrow", "upcoming"].map((key) => ({
    key,
    label: GROUP_LABELS[key],
    items: meetings.filter((meeting) => meeting.group === key),
  }));

  const hasAny = meetings.length > 0;

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={CalendarClock}
        iconClassName="bg-indigo-50 text-indigo-600"
        title="Upcoming meetings"
        description="From your team calendar."
        preview
      />

      <div className="mt-4 space-y-4">
        {!hasAny ? (
          <EmptyStateCard icon={CalendarClock} title="No meetings scheduled" />
        ) : (
          groups
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <div key={group.key}>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{group.label}</p>
                <div className="mt-2 space-y-1.5">
                  {group.items.map((meeting) => (
                    <div key={meeting.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-50">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                        <Video className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-900">{meeting.title}</p>
                        <p className="text-xs text-zinc-500">
                          {meeting.time} · {meeting.attendees} attendees
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
        )}
      </div>
    </DashboardCard>
  );
}
