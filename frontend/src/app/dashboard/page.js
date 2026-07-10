"use client";

import { useAuthStore } from "@/store/useAuthStore";
import { ROLES } from "@/constants/roles";
import OrgAdminDashboard from "@/components/dashboard/views/OrgAdminDashboard";
import ManagerDashboard from "@/components/dashboard/views/ManagerDashboard";
import HrDashboard from "@/components/dashboard/views/HrDashboard";
import EmployeeDashboard from "@/components/dashboard/views/EmployeeDashboard";
import GuestDashboard from "@/components/dashboard/views/GuestDashboard";
import SuperAdminDashboard from "@/components/dashboard/views/SuperAdminDashboard";

const DASHBOARD_BY_ROLE = {
  [ROLES.SUPER_ADMIN]: SuperAdminDashboard,
  [ROLES.ORG_ADMIN]: OrgAdminDashboard,
  [ROLES.ADMIN]: OrgAdminDashboard,
  [ROLES.MANAGER]: ManagerDashboard,
  [ROLES.HR]: HrDashboard,
  [ROLES.EMPLOYEE]: EmployeeDashboard,
  [ROLES.GUEST]: GuestDashboard,
};

export default function DashboardPage() {
  const role = useAuthStore((state) => state.user?.role);
  const RoleDashboard = DASHBOARD_BY_ROLE[role] ?? EmployeeDashboard;

  return (
    <div className="flex min-h-full flex-col bg-white">
      <div className="flex-1 p-8">
        <RoleDashboard />
      </div>
    </div>
  );
}
