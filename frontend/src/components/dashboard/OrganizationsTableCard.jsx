"use client";

import { Building2, MoreHorizontal, Ban, RotateCcw, Flag } from "lucide-react";
import { DashboardCard, DashboardCardHeader } from "@/components/dashboard/DashboardCard";
import EmptyStateCard from "@/components/dashboard/EmptyStateCard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  useSuspendOrganization,
  useReactivateOrganization,
  useUpdateOrganizationPlan,
  useUpdateFeatureFlags,
} from "@/features/platform/hooks/useOrganizationMutations";

const PLAN_STYLES = {
  free: "bg-zinc-100 text-zinc-600",
  starter: "bg-blue-50 text-blue-600",
  pro: "bg-violet-50 text-violet-700",
  enterprise: "bg-amber-50 text-amber-700",
};

const PLANS = ["free", "starter", "pro", "enterprise"];
const KNOWN_FLAGS = ["aiInsights", "betaFeatures", "advancedSecurity"];

export default function OrganizationsTableCard({ organizations, isLoading }) {
  const suspend = useSuspendOrganization();
  const reactivate = useReactivateOrganization();
  const updatePlan = useUpdateOrganizationPlan();
  const updateFlags = useUpdateFeatureFlags();

  return (
    <DashboardCard>
      <DashboardCardHeader
        icon={Building2}
        iconClassName="bg-violet-50 text-violet-600"
        title="Organizations"
        description="Every tenant on the platform."
      />

      <div className="mt-4">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-zinc-400">Loading…</p>
        ) : !organizations || organizations.length === 0 ? (
          <EmptyStateCard icon={Building2} title="No organizations yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-100">
                <TableHead className="text-xs text-zinc-500">Organization</TableHead>
                <TableHead className="text-xs text-zinc-500">Plan</TableHead>
                <TableHead className="text-xs text-zinc-500">Seats</TableHead>
                <TableHead className="text-xs text-zinc-500">Status</TableHead>
                <TableHead className="text-xs text-zinc-500">Created</TableHead>
                <TableHead className="text-xs text-zinc-500" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {organizations.map((org) => {
                const flags = org.featureFlags ?? {};
                return (
                  <TableRow key={org.id} className="border-zinc-100">
                    <TableCell className="text-sm font-medium text-zinc-900">{org.name}</TableCell>
                    <TableCell>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${PLAN_STYLES[org.plan] ?? PLAN_STYLES.free}`}>
                        {org.plan}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-zinc-500">{org.limits?.seats ?? "—"}</TableCell>
                    <TableCell>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          org.isActive ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
                        }`}
                      >
                        {org.isActive ? "Active" : "Suspended"}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-zinc-500">
                      {new Date(org.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="flex size-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                            aria-label={`Actions for ${org.name}`}
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuLabel>Change plan</DropdownMenuLabel>
                          {PLANS.map((plan) => (
                            <DropdownMenuItem
                              key={plan}
                              disabled={plan === org.plan || updatePlan.isPending}
                              onSelect={() => updatePlan.mutate({ organizationId: org.id, plan })}
                              className="capitalize"
                            >
                              {plan}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="flex items-center gap-1.5">
                            <Flag className="size-3.5" />
                            Feature flags
                          </DropdownMenuLabel>
                          {KNOWN_FLAGS.map((flag) => (
                            <DropdownMenuCheckboxItem
                              key={flag}
                              checked={Boolean(flags[flag])}
                              disabled={updateFlags.isPending}
                              onCheckedChange={(checked) =>
                                updateFlags.mutate({
                                  organizationId: org.id,
                                  featureFlags: { ...flags, [flag]: checked },
                                })
                              }
                            >
                              {flag}
                            </DropdownMenuCheckboxItem>
                          ))}
                          <DropdownMenuSeparator />
                          {org.isActive ? (
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={suspend.isPending}
                              onSelect={() => suspend.mutate({ organizationId: org.id })}
                            >
                              <Ban className="size-4" />
                              Suspend organization
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled={reactivate.isPending}
                              onSelect={() => reactivate.mutate({ organizationId: org.id })}
                            >
                              <RotateCcw className="size-4" />
                              Reactivate organization
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </DashboardCard>
  );
}
