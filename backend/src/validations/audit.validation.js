const { z } = require('zod');

const listAuditLogsQuerySchema = z.object({
  action: z.string().trim().min(1).optional(),
  userId: z.string().trim().min(1).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = {
  listAuditLogsQuerySchema,
};
