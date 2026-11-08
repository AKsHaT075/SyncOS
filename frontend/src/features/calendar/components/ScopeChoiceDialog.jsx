"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** "This event only" vs "All events in the series" — asked before editing or deleting a recurring event. */
export default function ScopeChoiceDialog({ open, onOpenChange, action, title, isPending, onChoose }) {
  const verb = action === "delete" ? "Delete" : "Edit";
  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{verb} recurring event</DialogTitle>
          <DialogDescription>“{title}” repeats. What do you want to {verb.toLowerCase()}?</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Button variant="outline" className="h-auto w-full flex-col items-start gap-0.5 py-3 text-left" disabled={isPending} onClick={() => onChoose("occurrence")}>
            <span className="font-medium">This event only</span>
            <span className="text-xs font-normal text-muted-foreground">Other events in the series are not affected.</span>
          </Button>
          <Button variant="outline" className="h-auto w-full flex-col items-start gap-0.5 py-3 text-left" disabled={isPending} onClick={() => onChoose("series")}>
            <span className="font-medium">All events in the series</span>
            <span className="text-xs font-normal text-muted-foreground">
              {action === "delete" ? "Removes every occurrence." : "Changes to the schedule reset any individually edited occurrences."}
            </span>
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {isPending ? <Loader2 className="size-4 animate-spin" /> : null}Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
