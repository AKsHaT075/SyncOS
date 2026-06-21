const { z } = require('zod');

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

module.exports = {
  createOrganizationSchema,
};
