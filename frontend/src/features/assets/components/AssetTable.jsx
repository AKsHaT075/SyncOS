"use client";

import Link from "next/link";
import { Laptop, KeyRound } from "lucide-react";
import { StatusBadge } from "@/features/assets/components/shared";
import { expiryLabel, formatMoney } from "@/features/assets/utils/format";

function Holder({ asset }) {
  if (asset.kind === "software") return <span className="text-muted-foreground">{asset.license?.allocatedSeats ?? 0}/{asset.license?.seats ?? 0} seats</span>;
  if (asset.assignedUser) {
    return (
      <span>
        {asset.assignedUser.name}
        {asset.assignedToFormerMember ? <span className="ml-1.5 rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:text-orange-400">left org</span> : null}
      </span>
    );
  }
  if (asset.assignedTeam) return <span>{asset.assignedTeam.name} <span className="text-xs text-muted-foreground">(team)</span></span>;
  return <span className="text-muted-foreground">—</span>;
}

function Warranty({ asset }) {
  const date = asset.kind === "software" ? asset.license?.expiryDate : asset.warranty.expiryDate;
  const label = expiryLabel(date);
  return label ? <span className={`text-xs ${label.tone}`}>{label.text}</span> : <span className="text-xs text-muted-foreground">—</span>;
}

/** Responsive list: a table from md up, stacked cards below. */
export default function AssetTable({ assets }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">Asset</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Category</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Held by</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Warranty / license</th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {assets.map((asset) => (
              <tr key={asset.id} className="hover:bg-accent/40">
                <td className="px-4 py-3">
                  <Link href={`/dashboard/assets/${asset.id}`} className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{asset.kind === "software" ? <KeyRound className="size-4" /> : <Laptop className="size-4" />}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">{asset.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{asset.assetId}{asset.assetTag ? ` · ${asset.assetTag}` : ""}{asset.serialNumber ? ` · ${asset.serialNumber}` : ""}</span>
                    </span>
                  </Link>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{asset.category?.name ?? "—"}</td>
                <td className="px-4 py-3"><StatusBadge status={asset.status} />{asset.archived ? <span className="ml-1 text-xs text-muted-foreground">(archived)</span> : null}</td>
                <td className="px-4 py-3 text-foreground"><Holder asset={asset} /></td>
                <td className="px-4 py-3"><Warranty asset={asset} /></td>
                <td className="px-4 py-3 text-right text-muted-foreground">{formatMoney(asset.purchase.cost, asset.purchase.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {assets.map((asset) => (
          <li key={asset.id}>
            <Link href={`/dashboard/assets/${asset.id}`} className="block rounded-xl border border-border bg-card p-3 hover:bg-accent/40">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{asset.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{asset.assetId} · {asset.category?.name ?? "No category"}</p>
                </div>
                <StatusBadge status={asset.status} />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs"><span className="text-foreground"><Holder asset={asset} /></span><Warranty asset={asset} /></div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
