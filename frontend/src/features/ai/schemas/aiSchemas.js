import { z } from "zod";

export const conversationTitleSchema = z.object({
  name: z.string().trim().min(1, "Enter a title").max(120, "Keep it under 120 characters"),
});
