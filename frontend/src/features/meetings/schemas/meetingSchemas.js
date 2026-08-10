import { z } from "zod";

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, "Invalid id");

// `startTime`/`endTime` come from <input type="datetime-local"> as
// "YYYY-MM-DDTHH:mm" strings — kept as strings through the form and only
// turned into Dates right before the request body is built.
export const scheduleMeetingSchema = z
  .object({
    topic: z.string().trim().min(2, "Topic must be at least 2 characters").max(200, "Topic is too long"),
    description: z.string().trim().max(5000, "Description is too long").optional().or(z.literal("")),
    participants: z.array(objectId).optional(),
    startTime: z.string().trim().min(1, "Start time is required"),
    endTime: z.string().trim().min(1, "End time is required"),
  })
  .refine((data) => new Date(data.endTime) > new Date(data.startTime), {
    message: "End time must be after the start time",
    path: ["endTime"],
  })
  // Mirrors the backend's createMeetingSchema — catch this client-side
  // instead of round-tripping to the server for something the form already
  // knows.
  .refine((data) => new Date(data.startTime).getTime() >= Date.now() - 60 * 1000, {
    message: "Start time cannot be in the past",
    path: ["startTime"],
  });

export const instantMeetingSchema = z.object({
  topic: z.string().trim().min(2, "Topic must be at least 2 characters").max(200, "Topic is too long"),
  description: z.string().trim().max(5000, "Description is too long").optional().or(z.literal("")),
  participants: z.array(objectId).optional(),
});

export const updateMeetingSchema = z
  .object({
    topic: z.string().trim().min(2, "Topic must be at least 2 characters").max(200, "Topic is too long"),
    description: z.string().trim().max(5000, "Description is too long").optional().or(z.literal("")),
    startTime: z.string().trim().min(1, "Start time is required"),
    endTime: z.string().trim().min(1, "End time is required"),
  })
  .refine((data) => new Date(data.endTime) > new Date(data.startTime), {
    message: "End time must be after the start time",
    path: ["endTime"],
  });
