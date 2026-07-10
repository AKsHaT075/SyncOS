import { FileText } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";

export default function LatestDocumentsCard({ documents, title = "Latest documents" }) {
  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={FileText}
        iconClassName="bg-sky-50 text-sky-600"
        title={title}
        description="Recently uploaded to your workspace."
        preview
      />

      <div className="mt-4 space-y-1">
        {documents.length === 0 ? (
          <EmptyStateCard icon={FileText} title="No documents yet" />
        ) : (
          documents.map((doc) => (
            <div key={doc.id} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-zinc-50">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                <FileText className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-900">{doc.name}</p>
                <p className="text-xs text-zinc-500">
                  {doc.uploader} · {doc.uploadedAt}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </DashboardCard>
  );
}
