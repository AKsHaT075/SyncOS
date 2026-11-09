const { z } = require('zod');
const { ANALYTICS_LIMITS, REPORT_TYPES } = require('../constants/analytics.constants');

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const baseQuery = {
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  teamId: objectId.optional(),
  userId: objectId.optional(),
  projectId: objectId.optional(),
  timezone: z.string().trim().max(60).optional(),
};

const analyticsQuerySchema = z.object(baseQuery).strict();
const platformQuerySchema = z.object({ from: dateOnly.optional(), to: dateOnly.optional(), timezone: z.string().trim().max(60).optional() }).strict();
const reportQuerySchema = z.object({
  ...baseQuery,
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(ANALYTICS_LIMITS.PAGE_MAX).default(25),
}).strict();
const exportQuerySchema = z.object(baseQuery).strict();
const reportParamsSchema = z.object({ type: z.enum(REPORT_TYPES) });

module.exports = { analyticsQuerySchema, exportQuerySchema, platformQuerySchema, reportParamsSchema, reportQuerySchema };
