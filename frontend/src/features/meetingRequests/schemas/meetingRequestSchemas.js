import { z } from "zod";

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, "Invalid id");

export const createMeetingRequestSchema = z.object({
  topic: z.string().trim().min(2, "Topic must be at least 2 characters").max(200, "Topic is too long"),
  reason: z.string().trim().min(2, "Reason must be at least 2 characters").max(2000, "Reason is too long"),
  requestedMembers: z.array(objectId).optional(),
  preferredDate: z.string().trim().optional().or(z.literal("")),
  preferredTime: z.string().trim().max(20).optional().or(z.literal("")),
});

export const decisionSchema = z.object({
  remarks: z.string().trim().max(2000, "Remarks are too long").optional().or(z.literal("")),
});

export const scheduleDecisionSchema = z
  .object({
    remarks: z.string().trim().max(2000).optional().or(z.literal("")),
    startTime: z.string().trim().min(1, "Start time is required"),
    endTime: z.string().trim().min(1, "End time is required"),
  })
  .refine((data) => new Date(data.endTime) > new Date(data.startTime), {
    message: "End time must be after the start time",
    path: ["endTime"],
  });
