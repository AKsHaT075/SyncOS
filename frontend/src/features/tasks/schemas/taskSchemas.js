import { z } from "zod";
import { TASK_PRIORITIES, TASK_VISIBILITIES, TASK_REVIEW_ACTIONS } from "@/features/tasks/constants/taskOptions";

const dateString = z.string().trim().optional().or(z.literal(""));
const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, "Invalid id");

const baseTaskFields = {
  title: z.string().trim().min(2, "Title must be at least 2 characters").max(200, "Title is too long"),
  description: z.string().trim().max(5000, "Description is too long").optional().or(z.literal("")),
  priority: z.enum(TASK_PRIORITIES, { errorMap: () => ({ message: "Choose a priority" }) }),
  visibility: z.enum(TASK_VISIBILITIES, { errorMap: () => ({ message: "Choose a visibility" }) }),
  startDate: dateString,
  dueDate: dateString,
  estimatedHours: z
    .union([z.string().trim(), z.number()])
    .optional()
    .or(z.literal(""))
    .refine((value) => value === "" || value === undefined || !Number.isNaN(Number(value)), {
      message: "Estimated hours must be a number",
    })
    .refine((value) => value === "" || value === undefined || Number(value) >= 0, {
      message: "Estimated hours can't be negative",
    }),
  owner: objectId.optional().or(z.literal("")),
  assignees: z.array(objectId).optional(),
  approvers: z.array(objectId).optional(),
  labels: z.array(z.string().trim().max(40)).optional(),
  tags: z.array(z.string().trim().max(40)).optional(),
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

export const createTaskSchema = z.object(baseTaskFields).superRefine(requireDueAfterStart);

export const updateTaskSchema = z
  .object({ ...baseTaskFields, title: baseTaskFields.title.optional() })
  .partial()
  .superRefine(requireDueAfterStart);

export const submitForReviewSchema = z.object({
  description: z.string().trim().min(1, "Submission description is required").max(5000),
});

export const reviewTaskSchema = z.object({
  action: z.enum(TASK_REVIEW_ACTIONS, { errorMap: () => ({ message: "Choose an action" }) }),
  remarks: z.string().trim().max(2000).optional().or(z.literal("")),
});
