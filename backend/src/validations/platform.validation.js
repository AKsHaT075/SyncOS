const { z } = require('zod');

const listOrganizationsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const updatePlanSchema = z.object({
  plan: z.enum(['free', 'starter', 'pro', 'enterprise']),
});

const suspendOrganizationSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

const updateFeatureFlagsSchema = z.object({
  featureFlags: z.record(z.string(), z.boolean()),
});

module.exports = {
  listOrganizationsQuerySchema,
  suspendOrganizationSchema,
  updateFeatureFlagsSchema,
  updatePlanSchema,
};
