"use client";

import LatestDocumentsCard from "@/components/dashboard/LatestDocumentsCard";
import UpcomingMeetingsCard from "@/components/dashboard/UpcomingMeetingsCard";
import { useDocuments } from "@/features/documents/hooks/documentHooks";
import { useMyMeetings } from "@/features/meetings/hooks/useMyMeetings";

// Real-data versions of the two dashboard cards that used to render mock rows. They reuse the existing
// presentational cards (preview={false} removes the Preview badge) and read the same APIs as the
// Documents and Meetings pages, so what a person sees is already filtered by the server's access rules.

const dayStart = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

function groupOf(start, now) {
  const diffDays = Math.round((dayStart(new Date(start)) - dayStart(now)) / 86400000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "tomorrow";
  return "upcoming";
}

export function LiveUpcomingMeetingsCard() {
  const { data, isLoading } = useMyMeetings({ status: "Scheduled", sortOrder: "asc", limit: 6 });
  const now = new Date();
  const meetings = (data?.meetings ?? []).map((meeting) => ({
    id: meeting._id || meeting.id,
    title: meeting.topic,
    group: groupOf(meeting.startTime, now),
    time: new Date(meeting.startTime).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    attendees: meeting.participants?.length ?? 0,
  }));
  if (isLoading) return <UpcomingMeetingsCard meetings={[]} preview={false} />;
  return <UpcomingMeetingsCard meetings={meetings} preview={false} />;
}

export function LiveLatestDocumentsCard({ title }) {
  const { data, isLoading } = useDocuments({ limit: 5, sortBy: "createdAt", sortOrder: "desc" });
  const documents = (data?.documents ?? data?.items ?? []).map((doc) => ({
    id: doc._id || doc.id,
    name: doc.name,
    uploader: doc.owner?.fullName ?? "",
    uploadedAt: doc.createdAt ? new Date(doc.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "",
  }));
  if (isLoading) return <LatestDocumentsCard documents={[]} title={title} preview={false} />;
  return <LatestDocumentsCard documents={documents} title={title} preview={false} />;
}
