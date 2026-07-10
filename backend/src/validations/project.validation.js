const { z } = require('zod');
const { PROJECT_STATUS, PROJECT_PRIORITY, PROJECT_VISIBILITY, PROJECT_TYPE, PROJECT_MEMBER_ROLES } = require('../constants/project.constants');

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const name = z.string().trim().min(2).max(120);
const description = z.string().trim().max(2000).optional();
const isInternal = z.coerce.boolean().optional();
const client = z.string().trim().max(120).optional();
const budget = z.coerce.number().min(0).optional().nullable();
const resourceLink = z.string().trim().url('Must be a valid URL').max(500).optional().or(z.literal(''));
const dateField = z.coerce.date().optional().nullable();

/**
 * z.coerce.boolean() coerces via Boolean(value), so the query string "false"
 * (a non-empty string) would incorrectly coerce to true. This only accepts
 * the two literal query-string values a boolean filter can actually take.
 */
const queryBoolean = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

const createProjectSchema = z
  .object({
    name,
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug can only contain lowercase letters, numbers, and hyphens')
      .min(2)
      .max(80)
      .optional(),
    description,
    type: z.enum(Object.values(PROJECT_TYPE)).optional(),
    isInternal,
    client,
    budget,
    resourceLink,
    owner: objectId.optional(),
    team: objectId.optional().nullable(),
    priority: z.enum(Object.values(PROJECT_PRIORITY)).optional(),
    visibility: z.enum(Object.values(PROJECT_VISIBILITY)).optional(),
    startDate: dateField,
    dueDate: dateField,
  })
  .refine((data) => !data.startDate || !data.dueDate || data.startDate <= data.dueDate, {
    message: 'Due date must be on or after the start date',
    path: ['dueDate'],
  });

const updateProjectSchema = z
  .object({
    name: name.optional(),
    description,
    type: z.enum(Object.values(PROJECT_TYPE)).optional(),
    isInternal,
    client,
    budget,
    resourceLink,
    owner: objectId.optional(),
    team: objectId.optional().nullable(),
    status: z.enum(Object.values(PROJECT_STATUS)).optional(),
    priority: z.enum(Object.values(PROJECT_PRIORITY)).optional(),
    visibility: z.enum(Object.values(PROJECT_VISIBILITY)).optional(),
    startDate: dateField,
    dueDate: dateField,
  })
  .refine((data) => !data.startDate || !data.dueDate || data.startDate <= data.dueDate, {
    message: 'Due date must be on or after the start date',
    path: ['dueDate'],
  });

const listProjectsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(Object.values(PROJECT_STATUS)).optional(),
  priority: z.enum(Object.values(PROJECT_PRIORITY)).optional(),
  type: z.enum(Object.values(PROJECT_TYPE)).optional(),
  owner: objectId.optional(),
  team: objectId.optional(),
  archived: queryBoolean,
  favorite: queryBoolean,
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt', 'dueDate', 'priority', 'status']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const activityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const addMemberSchema = z.object({
  userId: objectId,
  role: z.enum(Object.values(PROJECT_MEMBER_ROLES)).optional(),
});

const updateMemberRoleSchema = z.object({
  role: z.enum(Object.values(PROJECT_MEMBER_ROLES)),
});

const transferOwnershipSchema = z.object({
  newOwnerId: objectId,
});

module.exports = {
  activityQuerySchema,
  addMemberSchema,
  createProjectSchema,
  listProjectsQuerySchema,
  transferOwnershipSchema,
  updateMemberRoleSchema,
  updateProjectSchema,
};
