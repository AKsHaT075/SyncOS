import { z } from "zod";
import { ALLOWED_EXTENSIONS } from "@/features/documents/constants/documentOptions";
import { getExtension } from "@/features/documents/utils/format";

export const folderNameSchema = z.object({
  name: z.string().trim().min(1, "Enter a folder name").max(120, "Keep it under 120 characters"),
});

export const renameSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(180, "Keep it under 180 characters"),
});

export const shareFormSchema = z.object({
  userId: z.string().min(1, "Choose a person"),
  permission: z.enum(["viewer", "editor"]),
});

export const uploadFormSchema = z
  .object({
    name: z.string().trim().max(180).optional(),
    description: z.string().trim().max(1000).optional(),
    visibility: z.enum(["private", "team", "project", "organization"]),
    teamId: z.string().optional(),
    projectId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.visibility === "team" && !data.teamId) {
      ctx.addIssue({ code: "custom", path: ["teamId"], message: "Choose a team" });
    }
    if (data.visibility === "project" && !data.projectId) {
      ctx.addIssue({ code: "custom", path: ["projectId"], message: "Choose a project" });
    }
  });

/** Returns an error string, or null when the file looks acceptable. */
export function validateFileClientSide(file, { requireExtension } = {}) {
  if (!file) return "Choose a file";
  const extension = getExtension(file.name);
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return `.${extension || "?"} files aren't supported. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`;
  }
  if (requireExtension && extension !== requireExtension) {
    return `The replacement must be a .${requireExtension} file.`;
  }
  if (file.size === 0) return "That file is empty.";
  return null;
}
