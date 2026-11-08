import { z } from "zod";

const optionalText = (max) => z.string().trim().max(max, `Keep this under ${max} characters`).optional().or(z.literal(""));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date").or(z.literal("")).optional();
const money = z
  .string()
  .trim()
  .refine((value) => value === "" || (!Number.isNaN(Number(value)) && Number(value) >= 0), "Enter a valid amount")
  .optional();

export const assetFormSchema = z
  .object({
    name: z.string().trim().min(1, "Give the asset a name").max(150),
    kind: z.enum(["hardware", "software"]),
    categoryId: z.string().min(1, "Choose a category"),
    assetTag: optionalText(60),
    serialNumber: optionalText(100),
    brand: optionalText(100),
    model: optionalText(100),
    description: optionalText(2000),
    location: optionalText(150),
    teamId: z.string().optional(),
    condition: z.enum(["NEW", "GOOD", "FAIR", "POOR", "DAMAGED"]),
    purchaseDate: day,
    cost: money,
    currency: z.string().min(3),
   
    invoiceReference: optionalText(100),
    warrantyStart: day,
    warrantyExpiry: day,
    notes: optionalText(2000),
    // software
    licenseType: z.string().optional(),
    seats: z.string().optional(),
    licenseStart: day,
    licenseExpiry: day,
    licenseRenewal: day,
    keyReference: optionalText(200),
  })
  .superRefine((data, ctx) => {
    const issue = (path, message) => ctx.addIssue({ code: "custom", path: [path], message });
    if (data.warrantyStart && data.warrantyExpiry && data.warrantyExpiry < data.warrantyStart) issue("warrantyExpiry", "Warranty must end after it starts");
    if (data.kind === "software") {
      const seats = Number(data.seats);
      if (!Number.isInteger(seats) || seats < 1) issue("seats", "Enter the number of seats (1 or more)");
      if (data.licenseStart && data.licenseExpiry && data.licenseExpiry < data.licenseStart) issue("licenseExpiry", "License must end after it starts");
    }
  });

export const assignSchema = z.object({
  assigneeType: z.enum(["user", "team"]),
  userId: z.string().optional(),
  teamId: z.string().optional(),
  expectedReturnDate: day,
  condition: z.string().optional(),
  notes: optionalText(1000),
}).superRefine((data, ctx) => {
  if (data.assigneeType === "user" && !data.userId) ctx.addIssue({ code: "custom", path: ["userId"], message: "Choose a person" });
  if (data.assigneeType === "team" && !data.teamId) ctx.addIssue({ code: "custom", path: ["teamId"], message: "Choose a team" });
});

export const returnSchema = z.object({ condition: z.string().optional(), notes: optionalText(1000) });
export const noteSchema = z.object({ note: optionalText(500) });
export const issueSchema = z.object({ issue: z.string().trim().min(5, "Describe the problem (at least a few words)").max(2000), type: z.string().optional() });

export const maintenanceSchema = z.object({
  type: z.string().min(1),
  issue: z.string().trim().min(1, "Describe the work").max(2000),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date"),
  serviceProvider: optionalText(150),
  vendorId: z.string().optional(),
});
export const completeMaintenanceSchema = z.object({
  cost: money,
  currency: z.string().min(3),
  repairNotes: optionalText(5000),
  condition: z.string().optional(),
  nextMaintenanceDate: day,
});
export const approveSchema = z.object({ scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date"), serviceProvider: optionalText(150) });
export const nameSchema = z.object({ name: z.string().trim().min(1, "Enter a name").max(100), description: optionalText(500) });
export const vendorSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(150),
  contactPerson: optionalText(100),
  email: z.string().trim().email("Enter a valid email").or(z.literal("")).optional(),
  phone: optionalText(40),
  website: z.string().trim().url("Use a full link, e.g. https://…").or(z.literal("")).optional(),
  notes: optionalText(1000),
});
export const linkDocumentSchema = z.object({ documentId: z.string().min(1, "Choose a document"), kind: z.string().min(1) });
