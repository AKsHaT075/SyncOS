import { AlarmClockOff } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

export default function OverdueTasksCard({ tasks }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={AlarmClockOff}
        iconClassName="bg-red-50 text-red-600"
        title="Overdue tasks"
        description="Past their due date."
        preview
      />

      <div className="mt-4 space-y-1">
        {tasks.length === 0 ? (
          <EmptyStateCard icon={AlarmClockOff} title="Nothing overdue" description="Your team is on track." />
        ) : (
          tasks.map((task) => (
            <div key={task.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-zinc-50">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-900">{task.title}</p>
                <p className="text-xs text-zinc-500">{task.assignee}</p>
              </div>
              <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">
                {task.overdueBy}
              </span>
            </div>
          ))
        )}
      </div>
    </DashboardCard>
  );
}
