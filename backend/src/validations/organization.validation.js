const { z } = require('zod');

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug can only contain lowercase letters, numbers, and hyphens')
    .min(2)
    .max(60)
    .optional(),
  logo: z.string().trim().url('Logo must be a valid URL').max(2048).optional().nullable(),
});

module.exports = {
  createOrganizationSchema,
};
