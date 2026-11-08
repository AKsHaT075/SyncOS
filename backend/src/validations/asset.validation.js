const { z } = require('zod');
const {
  ASSET_CONDITION, ASSET_KIND, ASSET_STATUS, ASSIGNEE_TYPE, CURRENCIES, DOCUMENT_KIND, LICENSE_TYPE, LIMITS, MAINTENANCE_STATUS, MAINTENANCE_TYPE,
} = require('../constants/asset.constants');

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const isRealDate = (value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isRealDate, 'Not a real calendar date');
const optionalDate = dateOnly.nullable().optional();
const text = (max) => z.string().trim().max(max);
const optText = (max) => text(max).optional();
const money = z.number().min(0).max(1e12).nullable().optional();
const currency = z.enum(CURRENCIES);
const condition = z.enum(Object.values(ASSET_CONDITION));
const emptyToUndefined = (value) => (value === '' ? undefined : value);

const licenseSchema = z
  .object({
    licenseType: z.enum(Object.values(LICENSE_TYPE)).optional(),
    seats: z.number().int().min(1).max(LIMITS.MAX_SEATS),
    startDate: optionalDate,
    expiryDate: optionalDate,
    renewalDate: optionalDate,
    autoRenew: z.boolean().optional(),
    cost: money,
    currency: currency.optional(),
    // A pointer to where the key is kept (vault item, ticket…). Never the key itself.
    keyReference: optText(200),
  })
  .strict();

const assetFields = {
  name: text(200).min(1, 'Give the asset a name'),
  categoryId: objectId,
  subcategory: optText(100),
  description: optText(2000),
  brand: optText(100),
  model: optText(100),
  manufacturer: optText(100),
  serialNumber: z.preprocess(emptyToUndefined, text(100).optional()),
  assetTag: z.preprocess(emptyToUndefined, text(60).optional()),
  purchase: z
    .object({
      date: optionalDate,
      cost: money,
      currency: currency.optional(),
      vendorId: objectId.nullable().optional(),
      invoiceReference: optText(100),
      purchaseOrderReference: optText(100),
    })
    .strict()
    .optional(),
  condition: condition.optional(),
  location: optText(150),
  teamId: objectId.nullable().optional(),
  warranty: z.object({ startDate: optionalDate, expiryDate: optionalDate }).strict().optional(),
  maintenanceIntervalDays: z.number().int().min(1).max(3650).nullable().optional(),
  nextMaintenanceDate: optionalDate,
  notes: optText(5000),
};

const datesInOrder = (start, end) => !start || !end || end >= start;

const createAssetSchema = z
  .object({ ...assetFields, kind: z.enum(Object.values(ASSET_KIND)).default(ASSET_KIND.HARDWARE), license: licenseSchema.optional() })
  .strict()
  .superRefine((data, ctx) => {
    const issue = (path, message) => ctx.addIssue({ code: 'custom', path, message });
    if (data.kind === ASSET_KIND.SOFTWARE && !data.license) issue(['license'], 'Software assets need license details');
    if (data.kind === ASSET_KIND.HARDWARE && data.license) issue(['license'], 'Only software assets have a license');
    if (!datesInOrder(data.warranty?.startDate, data.warranty?.expiryDate)) issue(['warranty', 'expiryDate'], 'The warranty must end after it starts');
    if (!datesInOrder(data.license?.startDate, data.license?.expiryDate)) issue(['license', 'expiryDate'], 'The license must end after it starts');
  });

// `kind` is fixed at creation (a laptop never becomes a license).
const updateAssetSchema = z
  .object({
    ...Object.fromEntries(Object.entries(assetFields).map(([key, schema]) => [key, schema.optional()])),
    license: licenseSchema.partial().strict().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field to update is required', path: ['name'] })
  .superRefine((data, ctx) => {
    if (!datesInOrder(data.warranty?.startDate, data.warranty?.expiryDate)) {
      ctx.addIssue({ code: 'custom', path: ['warranty', 'expiryDate'], message: 'The warranty must end after it starts' });
    }
  });

const csv = (values) =>
  z.string().max(300).transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean)).pipe(z.array(z.enum(values)));

const listAssetsQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    categoryId: objectId.optional(),
    status: csv(Object.values(ASSET_STATUS)).optional(),
    kind: z.enum(Object.values(ASSET_KIND)).optional(),
    assignedUserId: objectId.optional(),
    teamId: objectId.optional(), // the owning team ("department")
    holderTeamId: objectId.optional(), // the team currently holding it
    location: z.string().trim().max(150).optional(),
    holder: z.enum(['unassigned', 'former']).optional(), // 'former' = held by someone who has left / been blocked
    warranty: z.enum(['active', 'expiring', 'expired', 'none']).optional(),
    maintenance: z.enum(['in_progress', 'due_soon', 'overdue']).optional(),
    purchasedFrom: dateOnly.optional(),
    purchasedTo: dateOnly.optional(),
    includeArchived: z.enum(['true', 'false']).default('false'),
    sortBy: z.enum(['name', 'assetId', 'createdAt', 'purchaseDate', 'warrantyExpiry', 'status', 'cost']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(LIMITS.PAGE_MAX).default(20),
  })
  .strict();

const assigneeTarget = {
  assigneeType: z.enum(Object.values(ASSIGNEE_TYPE)).default(ASSIGNEE_TYPE.USER),
  userId: objectId.optional(),
  teamId: objectId.optional(),
};
const requireTarget = (data, ctx) => {
  if (data.assigneeType === ASSIGNEE_TYPE.USER && !data.userId) ctx.addIssue({ code: 'custom', path: ['userId'], message: 'Choose a person' });
  if (data.assigneeType === ASSIGNEE_TYPE.TEAM && !data.teamId) ctx.addIssue({ code: 'custom', path: ['teamId'], message: 'Choose a team' });
};

const assignSchema = z
  .object({ ...assigneeTarget, expectedReturnDate: optionalDate, notes: optText(1000), condition: condition.optional() })
  .strict()
  .superRefine(requireTarget);

// Software seats: say whose seat is being moved; hardware has exactly one holder.
const transferSchema = z
  .object({ ...assigneeTarget, fromUserId: objectId.optional(), expectedReturnDate: optionalDate, notes: optText(1000), condition: condition.optional() })
  .strict()
  .superRefine(requireTarget);

const returnSchema = z
  .object({ condition: condition.optional(), notes: optText(1000), userId: objectId.optional() })
  .strict();

const noteSchema = z.object({ note: optText(500) }).strict();
const foundSchema = z.object({ note: optText(500), condition: condition.optional() }).strict();
const requestReturnSchema = z.object({ userId: objectId.optional(), note: optText(500) }).strict();

const maintenanceFields = {
  type: z.enum(Object.values(MAINTENANCE_TYPE)).optional(),
  issue: text(2000).min(1, 'Describe the work'),
  serviceProvider: optText(150),
  vendorId: objectId.nullable().optional(),
  scheduledDate: optionalDate,
  nextMaintenanceDate: optionalDate,
  cost: money,
  currency: currency.optional(),
  repairNotes: optText(5000),
};

const createMaintenanceSchema = z.object({ ...maintenanceFields, scheduledDate: dateOnly }).strict();
const updateMaintenanceSchema = z
  .object(Object.fromEntries(Object.entries(maintenanceFields).map(([key, schema]) => [key, schema.optional()])))
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field to update is required', path: ['issue'] });
const reportIssueSchema = z.object({ issue: text(2000).min(5, 'Describe the problem'), type: z.enum(Object.values(MAINTENANCE_TYPE)).optional() }).strict();
const approveMaintenanceSchema = z.object({ scheduledDate: dateOnly, serviceProvider: optText(150), vendorId: objectId.nullable().optional() }).strict();
const declineMaintenanceSchema = z.object({ reason: optText(500) }).strict();
const completeMaintenanceSchema = z
  .object({ completedDate: optionalDate, cost: money, currency: currency.optional(), repairNotes: optText(5000), nextMaintenanceDate: optionalDate, condition: condition.optional() })
  .strict();

const listMaintenanceQuerySchema = z
  .object({
    status: csv(Object.values(MAINTENANCE_STATUS)).optional(),
    assetId: objectId.optional(),
    view: z.enum(['upcoming', 'overdue', 'requests']).optional(),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(LIMITS.PAGE_MAX).default(20),
  })
  .strict();

const listAssignmentsQuerySchema = z
  .object({
    status: z.enum(['ACTIVE', 'CLOSED']).optional(),
    userId: objectId.optional(),
    teamId: objectId.optional(),
    assetId: objectId.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(LIMITS.PAGE_MAX).default(20),
  })
  .strict();

const categorySchema = z.object({ name: text(100).min(1, 'Give the category a name'), description: optText(500) }).strict();
const updateCategorySchema = categorySchema.partial().strict().refine((data) => Object.keys(data).length > 0, { message: 'At least one field to update is required', path: ['name'] });
const archiveCategorySchema = z.object({ moveTo: objectId.optional() }).strict();
const listCatalogQuerySchema = z.object({ includeArchived: z.enum(['true', 'false']).default('false'), search: z.string().trim().max(120).optional() }).strict();

const vendorFields = {
  name: text(150).min(1, 'Give the vendor a name'),
  contactPerson: optText(100),
  email: z.union([z.literal(''), z.string().trim().email().max(150)]).optional(),
  phone: optText(40),
  address: optText(400),
  website: z.union([z.literal(''), z.string().trim().url().max(200).refine((v) => /^https?:\/\//i.test(v), 'Use an http(s) link')]).optional(),
  notes: optText(1000),
};
const vendorSchema = z.object(vendorFields).strict();
const updateVendorSchema = z.object(Object.fromEntries(Object.entries(vendorFields).map(([k, s]) => [k, s.optional()]))).strict()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field to update is required', path: ['name'] });

const linkDocumentSchema = z
  .object({ documentId: objectId, kind: z.enum(Object.values(DOCUMENT_KIND)).default(DOCUMENT_KIND.OTHER), maintenanceId: objectId.optional() })
  .strict();

const pageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(LIMITS.PAGE_MAX).default(20) }).strict();
const summaryQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(60) }).strict();

module.exports = {
  approveMaintenanceSchema, archiveCategorySchema, assignSchema, categorySchema, completeMaintenanceSchema, createAssetSchema,
  createMaintenanceSchema, declineMaintenanceSchema, foundSchema, linkDocumentSchema, listAssetsQuerySchema, listAssignmentsQuerySchema,
  listCatalogQuerySchema, listMaintenanceQuerySchema, noteSchema, pageQuerySchema, reportIssueSchema, requestReturnSchema, returnSchema,
  summaryQuerySchema, transferSchema, updateAssetSchema, updateCategorySchema, updateMaintenanceSchema, updateVendorSchema, vendorSchema,
};
