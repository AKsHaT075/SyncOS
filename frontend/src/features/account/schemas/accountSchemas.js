import { z } from "zod";

// Mirrors backend/src/validations/auth.validation.js and organization.validation.js. The server stays the authority.
export const profileSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(80, "Too long"),
  lastName: z.string().trim().min(1, "Last name is required").max(80, "Too long"),
  skills: z.string().max(2000, "Too long").optional(),
});

export const parseSkills = (value) =>
  [...new Set(String(value || "").split(",").map((skill) => skill.trim()).filter(Boolean))].slice(0, 50);

export const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z
      .string()
      .min(8, "At least 8 characters")
      .max(128, "Too long")
      .refine((value) => /[a-z]/.test(value), "Add a lowercase letter")
      .refine((value) => /[A-Z]/.test(value), "Add an uppercase letter")
      .refine((value) => /\d/.test(value), "Add a number"),
    confirmPassword: z.string().min(1, "Repeat the new password"),
  })
  .refine((value) => value.newPassword === value.confirmPassword, { message: "Passwords do not match", path: ["confirmPassword"] })
  .refine((value) => value.currentPassword !== value.newPassword, { message: "Choose a different password", path: ["newPassword"] });

export const organizationSchema = z.object({
  name: z.string().trim().min(2, "At least 2 characters").max(120, "Too long"),
  logo: z.string().trim().max(2048, "Too long").refine((value) => !value || /^https?:\/\//i.test(value), "Use a full http(s) URL").optional(),
  timeZone: z.string().trim().max(64).optional(),
});
