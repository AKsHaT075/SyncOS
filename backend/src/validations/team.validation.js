const { z } = require('zod');
const { ROLES } = require('../constants/roles');

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const createTeamSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  lead: objectId.optional().nullable(),
});

const updateTeamSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(500).optional().nullable(),
  })
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: 'At least one field to update is required',
    path: ['name'],
  });

const listTeamsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const addMemberSchema = z.object({
  userId: objectId,
});

const setManagerSchema = z.object({
  userId: objectId,
});

const memberCandidatesQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  role: z.enum(Object.values(ROLES)).optional(),
});

module.exports = {
  addMemberSchema,
  createTeamSchema,
  listTeamsQuerySchema,
  memberCandidatesQuerySchema,
  setManagerSchema,
  updateTeamSchema,
};