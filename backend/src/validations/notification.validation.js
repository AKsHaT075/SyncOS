const { z } = require('zod');
const { CONFIGURABLE_CATEGORIES, MAX_PAGE_SIZE, NOTIFICATION_CATEGORIES } = require('../constants/notification.constants');

const categoryEnum = z.enum(Object.values(NOTIFICATION_CATEGORIES));

const listNotificationsQuerySchema = z
  .object({
    cursor: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    status: z.enum(['all', 'unread']).default('all'),
    category: categoryEnum.optional(),
  })
  .strict();

const markAllReadSchema = z.object({ category: categoryEnum.optional() }).strict();

const channelsPatch = z.object({ inApp: z.boolean().optional(), email: z.boolean().optional() }).strict();

// `security` is intentionally not accepted anywhere: it cannot be disabled.
const updatePreferencesSchema = z
  .object({
    channels: channelsPatch.optional(),
    categories: z
      .object(Object.fromEntries(CONFIGURABLE_CATEGORIES.map((category) => [category, channelsPatch.optional()])))
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (data) =>
      Object.keys(data.channels || {}).length > 0 ||
      Object.values(data.categories || {}).some((channels) => channels && Object.keys(channels).length > 0),
    { message: 'At least one preference to update is required', path: ['channels'] },
  );

module.exports = { listNotificationsQuerySchema, markAllReadSchema, updatePreferencesSchema };
