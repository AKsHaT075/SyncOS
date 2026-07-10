import { z } from "zod";
import { ROLES } from "@/constants/roles";

// Mirrors backend/src/validations/invitation.validation.js — org admins and
// admins can invite into these four roles.
export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  role: z.enum([ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE], {
    errorMap: () => ({ message: "Choose a role" }),
  }),
});
