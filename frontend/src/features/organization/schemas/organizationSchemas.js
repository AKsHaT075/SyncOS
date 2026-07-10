import { z } from "zod";

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120, "Name is too long"),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens only")
    .min(2, "Slug must be at least 2 characters")
    .max(60, "Slug is too long")
    .optional()
    .or(z.literal("")),
  logo: z.string().trim().url("Enter a valid URL").max(2048).optional().or(z.literal("")),
});

export const joinOrganizationSchema = z.object({
  token: z.string().trim().min(32, "Enter a valid invite code or link"),
});
