import { ListTodo, CheckCircle2, Circle } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

const PRIORITY_STYLES = {
  high: "bg-red-50 text-red-700",
  medium: "bg-amber-50 text-amber-700",
  low: "bg-zinc-100 text-zinc-600",
};

export default function TodaysTasksCard({ tasks, title = "My tasks" }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={ListTodo}
        iconClassName="bg-violet-50 text-violet-600"
        title={title}
        description="What's on your plate."
        preview
      />

      <div className="mt-4 space-y-1">
        {tasks.length === 0 ? (
          <EmptyStateCard icon={ListTodo} title="Nothing due today" />
        ) : (
          tasks.map((task) => (
            <div key={task.id} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-zinc-50">
              {task.done ? (
                <CheckCircle2 className="size-4.5 shrink-0 text-emerald-500" />
              ) : (
                <Circle className="size-4.5 shrink-0 text-zinc-300" />
              )}
              <p className={`min-w-0 flex-1 truncate text-sm ${task.done ? "text-zinc-400 line-through" : "text-zinc-800"}`}>
                {task.title}
              </p>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${PRIORITY_STYLES[task.priority]}`}>
                {task.priority}
              </span>
            </div>
          ))
        )}
      </div>
    </DashboardCard>
  );
}
