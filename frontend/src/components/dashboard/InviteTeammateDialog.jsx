"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { UserPlus } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inviteUserSchema } from "@/features/invitations/schemas/invitationSchemas";
import { useInviteUser } from "@/features/invitations/hooks/useInviteUser";
import { useAuthStore } from "@/store/useAuthStore";
import { ROLES } from "@/constants/roles";
import { getFriendlyErrorMessage } from "@/lib/error-message";

const BASE_ROLE_OPTIONS = [
  { value: ROLES.EMPLOYEE, label: "Employee" },
  { value: ROLES.MANAGER, label: "Manager" },
  { value: ROLES.HR, label: "HR" },
];

// Only the org owner (ORG_ADMIN) may grant the Admin tier — an existing
// Admin cannot invite or promote another Admin.
const ADMIN_ROLE_OPTION = { value: ROLES.ADMIN, label: "Admin" };

export default function InviteTeammateDialog({ children }) {
  const [open, setOpen] = useState(false);
  const mutation = useInviteUser();
  const isOrgOwner = useAuthStore((state) => state.user?.role === ROLES.ORG_ADMIN);
  const roleOptions = isOrgOwner ? [...BASE_ROLE_OPTIONS, ADMIN_ROLE_OPTION] : BASE_ROLE_OPTIONS;
  const form = useForm({
    defaultValues: { email: "", role: ROLES.EMPLOYEE },
    resolver: zodResolver(inviteUserSchema),
    mode: "onTouched",
  });

  const onSubmit = async (values) => {
    mutation.reset();
    try {
      await mutation.mutateAsync(values);
      form.reset();
      setOpen(false);
    } catch {
      // mutation handles toast feedback
    }
  };

  const errorMessage = mutation.error ? getFriendlyErrorMessage(mutation.error) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) form.reset();
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600">
              <UserPlus className="size-4" />
            </span>
            Invite a teammate
          </DialogTitle>
          <DialogDescription>They'll get an email with a link to join your workspace.</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="invite-email">
              Email address
            </label>
            <Input id="invite-email" placeholder="teammate@company.com" {...form.register("email")} />
            {form.formState.errors.email ? (
              <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="invite-role">
              Role
            </label>
            <select
              id="invite-role"
              className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              {...form.register("role")}
            >
              {roleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {form.formState.errors.role ? (
              <p className="text-sm text-destructive">{form.formState.errors.role.message}</p>
            ) : null}
          </div>

          {errorMessage ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}

          <DialogFooter className="!mx-0 !mb-0 !rounded-none !border-t-0 !bg-transparent !p-0">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Sending invite..." : "Send invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
