import { z } from "zod";
import { PROJECT_PRIORITIES, PROJECT_VISIBILITIES, PROJECT_TYPES } from "@/features/projects/constants/projectOptions";

const dateString = z.string().trim().optional().or(z.literal(""));

const baseProjectFields = {
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120, "Name is too long"),
  description: z.string().trim().max(2000, "Description is too long").optional().or(z.literal("")),
  type: z.enum(PROJECT_TYPES, { errorMap: () => ({ message: "Choose a project type" }) }),
  isInternal: z.boolean().optional(),
  client: z.string().trim().max(120, "Client name is too long").optional().or(z.literal("")),
  budget: z
    .union([z.string().trim(), z.number()])
    .optional()
    .or(z.literal(""))
    .refine((value) => value === "" || value === undefined || !Number.isNaN(Number(value)), {
      message: "Budget must be a number",
    })
    .refine((value) => value === "" || value === undefined || Number(value) >= 0, {
      message: "Budget can't be negative",
    }),
  resourceLink: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal(""))
    .refine((value) => !value || /^https?:\/\/.+/i.test(value), {
      message: "Must be a valid URL starting with http:// or https://",
    }),
  owner: z.string().trim().optional().or(z.literal("")),
  team: z.string().trim().optional().or(z.literal("")),
  priority: z.enum(PROJECT_PRIORITIES, { errorMap: () => ({ message: "Choose a priority" }) }),
  visibility: z.enum(PROJECT_VISIBILITIES, { errorMap: () => ({ message: "Choose a visibility" }) }),
  startDate: dateString,
  dueDate: dateString,
};

function requireDueAfterStart(data, ctx) {
  if (data.startDate && data.dueDate && new Date(data.startDate) > new Date(data.dueDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Due date must be on or after the start date",
      path: ["dueDate"],
    });
  }
}

export const createProjectSchema = z.object(baseProjectFields).superRefine(requireDueAfterStart);

export const updateProjectSchema = z
  .object({ ...baseProjectFields, name: baseProjectFields.name.optional() })
  .partial()
  .superRefine(requireDueAfterStart);

export const renameProjectSchema = z.object({
  name: baseProjectFields.name,
});

export const updateDetailsSchema = z.object({
  name: baseProjectFields.name,
  description: baseProjectFields.description,
});

export const transferOwnershipSchema = z.object({
  newOwnerId: z.string().trim().regex(/^[a-f0-9]{24}$/i, "Invalid user"),
});
