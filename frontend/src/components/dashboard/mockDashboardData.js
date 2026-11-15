// Centralized preview/mock data for dashboard widgets that don't have a
// backend endpoint yet. Keeping it in one place means every role's
// dashboard stays consistent (e.g. the same 5 projects show up in the
// org-admin table, the manager's workload view, and at-risk widgets).

export const MOCK_PROJECTS = [
  { id: 1, name: "Onboarding v2", status: "on track", priority: "high", owner: "Akshat Anand", tasks: "23/28", due: "Jul 02", pinned: true },
  { id: 2, name: "Billing migration", status: "at risk", priority: "high", owner: "Priya Shah", tasks: "9/20", due: "Jul 18", pinned: false },
  { id: 3, name: "Mobile app", status: "on track", priority: "medium", owner: "Dev Patel", tasks: "31/49", due: "Aug 05", pinned: true },
  { id: 4, name: "Audit dashboard", status: "blocked", priority: "high", owner: "Akshat Anand", tasks: "7/25", due: "Jun 30", pinned: false },
  { id: 5, name: "Design system v3", status: "on track", priority: "low", owner: "Riya Mehta", tasks: "20/22", due: "Jun 26", pinned: false },
];

export const TEAM_INSIGHTS = {
  mostActive: "Engineering",
  largest: "Engineering",
  largestCount: 6,
};

export const TASK_STATUS_BREAKDOWN = [
  { name: "Done", value: 18, color: "#10b981" },
  { name: "In progress", value: 9, color: "#6366f1" },
  { name: "Blocked", value: 2, color: "#ef4444" },
  { name: "Backlog", value: 7, color: "#a1a1aa" },
];

export const MOCK_MEETINGS = [
  { id: 1, group: "today", title: "Sprint standup", time: "10:00 AM", attendees: 6 },
  { id: 2, group: "today", title: "Phoenix risk review", time: "3:30 PM", attendees: 4 },
  { id: 3, group: "tomorrow", title: "1:1 with Priya", time: "11:00 AM", attendees: 2 },
  { id: 4, group: "upcoming", title: "Quarterly planning", time: "Jun 28, 2:00 PM", attendees: 12 },
];

export const TEAM_WORKLOAD = [
  { team: "Engineering", utilization: 85 },
  { team: "Design", utilization: 62 },
  { team: "Backend", utilization: 90 },
  { team: "Support", utilization: 48 },
];

export const DEPARTMENTS = [
  { name: "Engineering", value: 14, color: "#6366f1" },
  { name: "Design", value: 4, color: "#0ea5e9" },
  { name: "Sales", value: 6, color: "#10b981" },
  { name: "Support", value: 3, color: "#f59e0b" },
];

// Shaped for RecentActivityFeed's `preview` mode — the real /audit-logs
// endpoint is org-admin only, so other roles fall back to this.
export const PREVIEW_ACTIVITY = [
  { id: 1, text: "John joined the workspace.", time: "2h ago", success: true },
  { id: 2, text: "Sarah changed Mike's role to Manager.", time: "5h ago", success: true },
  { id: 3, text: "Project Phoenix was updated.", time: "1d ago", success: true },
  { id: 4, text: "Failed login attempt blocked.", time: "2d ago", success: false },
];

export const OVERDUE_TASKS = [
  { id: 1, title: "Fix billing webhook retries", assignee: "Priya Shah", overdueBy: "2d overdue" },
  { id: 2, title: "Finalize audit dashboard wireframes", assignee: "Akshat Anand", overdueBy: "1d overdue" },
];

export const TODAYS_TASKS = [
  { id: 1, title: "Review Phoenix PR #482", priority: "high", done: false },
  { id: 2, title: "Standup notes", priority: "low", done: true },
  { id: 3, title: "Update onboarding checklist", priority: "medium", done: false },
  { id: 4, title: "Reply to design feedback thread", priority: "medium", done: false },
];

export const MY_PROJECTS = [
  { id: 1, name: "Onboarding v2", role: "Contributor", status: "on track", lastUpdated: "2h ago" },
  { id: 3, name: "Mobile app", role: "Reviewer", status: "at risk", lastUpdated: "1d ago" },
  { id: 5, name: "Design system v3", role: "Contributor", status: "done", lastUpdated: "3d ago" },
];

export const MY_TEAM = [
  { id: 1, name: "Priya Shah", role: "Manager" },
  { id: 2, name: "Dev Patel", role: "Engineer" },
  { id: 3, name: "Riya Mehta", role: "Designer" },
  { id: 4, name: "Akshat Anand", role: "Engineer" },
];

export const NEW_HIRES = [
  { id: 1, name: "Maya Iyer", progress: 80, nextStep: "IT equipment pending" },
  { id: 2, name: "Rohan Verma", progress: 45, nextStep: "Awaiting manager 1:1" },
  { id: 3, name: "Sara Khan", progress: 20, nextStep: "Documents not submitted" },
];

// Shaped for PendingInvitationsCard — the real endpoint is org-admin only,
// so HR's view falls back to this until a broader read-permission ships.
export const PREVIEW_INVITATIONS = [
  { id: "p1", email: "maya.iyer@example.com", role: "employee", createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString() },
  { id: "p2", email: "rohan.verma@example.com", role: "employee", createdAt: new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString() },
  { id: "p3", email: "sara.khan@example.com", role: "manager", createdAt: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString() },
];

export const UPCOMING_BIRTHDAYS = [
  { id: 1, name: "Priya Shah", date: "Jun 27" },
  { id: 2, name: "Dev Patel", date: "Jul 03" },
];

export const RECENTLY_JOINED = [
  { id: 1, name: "Maya Iyer", role: "employee", joinedAt: "3d ago" },
  { id: 2, name: "Rohan Verma", role: "employee", joinedAt: "6d ago" },
  { id: 3, name: "Sara Khan", role: "manager", joinedAt: "2w ago" },
];

export const LATEST_DOCUMENTS = [
  { id: 1, name: "Q3 roadmap.pdf", uploader: "Akshat Anand", uploadedAt: "2h ago" },
  { id: 2, name: "Billing migration plan.docx", uploader: "Priya Shah", uploadedAt: "1d ago" },
  { id: 3, name: "Brand guidelines v3.fig", uploader: "Riya Mehta", uploadedAt: "3d ago" },
];

export const ASSIGNED_GOALS = [
  { id: 1, title: "Ship onboarding v2", progress: 70 },
  { id: 2, title: "Reduce churn by 5%", progress: 35 },
];

export const PINNED_ITEMS = [
  { id: 1, type: "document", title: "Team handbook" },
  { id: 2, type: "link", title: "Design system Figma" },
];

export const ANNOUNCEMENTS = [
  { id: 1, title: "Office closed July 4th for the holiday.", postedAt: "1d ago" },
  { id: 2, title: "New expense policy is live — check the handbook.", postedAt: "4d ago" },
];

export const HEALTH_BREAKDOWN = [
  { label: "Security", score: 88 },
  { label: "Team activity", score: 74 },
  { label: "Overdue tasks", score: 61 },
  { label: "Pending invitations", score: 92 },
];

export const PLATFORM_HEALTH_STATS = [
  { label: "API uptime", value: "99.98%", healthy: true },
  { label: "Job queue", value: "Healthy", healthy: true },
  { label: "Error rate (24h)", value: "0.4%", healthy: true },
  { label: "DB replication lag", value: "210ms", healthy: true },
];

export const GLOBAL_FEATURE_FLAGS = [
  { key: "aiInsights", rollout: 65 },
  { key: "betaFeatures", rollout: 20 },
  { key: "advancedSecurity", rollout: 40 },
];

export const GROWTH_DATA = [
  { month: "Jan", organizations: 12 },
  { month: "Feb", organizations: 18 },
  { month: "Mar", organizations: 25 },
  { month: "Apr", organizations: 31 },
  { month: "May", organizations: 40 },
  { month: "Jun", organizations: 52 },
];

export function aiInsightsFor(role) {
  switch (role) {
    case "org-admin":
      return [
        { tone: "warning", text: "7 tasks are overdue across active projects." },
        { tone: "info", text: "3 invitations are pending acceptance." },
        { tone: "warning", text: "Engineering team workload reached 85%." },
        { tone: "critical", text: "Project Phoenix may miss its Jul 2 deadline." },
      ];
    case "manager":
      return [
        { tone: "critical", text: "Backend team workload reached 90%." },
        { tone: "warning", text: "Project Phoenix is behind schedule." },
      ];
    case "hr":
      return [
        { tone: "warning", text: "Engineering team is nearing seat capacity." },
        { tone: "info", text: "3 invitations are pending." },
      ];
    case "employee":
    default:
      return [{ tone: "info", text: "You have 4 tasks due this week." }];
  }
}
