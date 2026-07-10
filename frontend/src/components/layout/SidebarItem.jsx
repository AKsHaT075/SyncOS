"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function SidebarItem({ item, collapsed, badge }) {
  const pathname = usePathname();
  const Icon = item.icon;
  const isActive =
    pathname === item.href ||
    (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));

  const link = (
    <Link
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-zinc-400 transition-colors duration-200 ease-out",
        "hover:bg-white/[0.05] hover:text-zinc-100",
        collapsed && "justify-center px-2",
        isActive && "bg-white/[0.09] text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] hover:bg-white/[0.09]"
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0 transition-colors duration-200",
          isActive ? "text-violet-300" : "text-zinc-500 group-hover:text-zinc-200"
        )}
      />
      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
      {!collapsed && badge > 0 ? (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-violet-600 px-1 text-[11px] font-semibold text-white shadow-sm shadow-violet-500/40">
          {badge}
        </span>
      ) : null}
    </Link>
  );

  if (!collapsed) {
    return link;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}
