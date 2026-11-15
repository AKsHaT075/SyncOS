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

const { isValidTimeZone } = require('../utils/timezone');

const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    logo: z.string().trim().url('Logo must be a valid URL').max(2048).nullable().optional(),
    timeZone: z.string().trim().max(64).refine(isValidTimeZone, 'Unknown time zone').optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

module.exports = {
  updateOrganizationSchema,
  createOrganizationSchema,
};
