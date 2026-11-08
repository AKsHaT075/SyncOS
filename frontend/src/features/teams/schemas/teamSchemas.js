import { z } from "zod";

export const createTeamSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80, "Name cannot exceed 80 characters"),
  description: z.string().trim().max(500, "Description cannot exceed 500 characters").optional().or(z.literal("")),
  lead: z.string().trim().regex(/^[a-f0-9]{24}$/i, "Invalid user ID").optional().or(z.literal("")).nullable(),
});

export const updateTeamSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80, "Name cannot exceed 80 characters").optional(),
  description: z.string().trim().max(500, "Description cannot exceed 500 characters").optional().or(z.literal("")).nullable(),
});
