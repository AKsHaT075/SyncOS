import { Pin, FileText, Link2 } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

const TYPE_ICON = {
  document: FileText,
  link: Link2,
};

export default function PinnedItemsCard({ items }) {
  return (
    <DashboardCard>
      <DashboardCardHeader icon={Pin} iconClassName="bg-amber-50 text-amber-600" title="Pinned items" />

      <div className="mt-4 space-y-1">
        {items.length === 0 ? (
          <EmptyStateCard icon={Pin} title="Nothing pinned yet" />
        ) : (
          items.map((item) => {
            const Icon = TYPE_ICON[item.type] ?? FileText;
            return (
              <div key={item.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-50">
                <Icon className="size-4 shrink-0 text-zinc-400" />
                <span className="truncate text-sm text-zinc-800">{item.title}</span>
              </div>
            );
          })
        )}
      </div>
    </DashboardCard>
  );
}
