const { z } = require('zod');
const { ROLES } = require('../constants/roles');

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

// SUPER_ADMIN is a platform role and ORG_ADMIN is the org owner — neither is
// assignable through the people directory's quick role-change action.
const ASSIGNABLE_ROLES = [ROLES.ADMIN, ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.GUEST];

const listPeopleQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  role: z.enum(Object.values(ROLES)).optional(),
  team: objectId.optional(),
  sortBy: z.enum(['name', 'role', 'createdAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const updatePersonSchema = z
  .object({
    skills: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    orgBlocked: z.boolean().optional(),
    role: z.enum(ASSIGNABLE_ROLES).optional(),
    teamId: objectId.optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field to update is required',
  });

module.exports = {
  ASSIGNABLE_ROLES,
  listPeopleQuerySchema,
  updatePersonSchema,
};