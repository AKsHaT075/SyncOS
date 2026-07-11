const { z } = require('zod');
const { TASK_STATUS, TASK_PRIORITY, TASK_VISIBILITY, TASK_REVIEW_ACTION } = require('../constants/task.constants');

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const title = z.string().trim().min(2).max(200);
const description = z.string().trim().max(5000).optional();
const estimatedHours = z.coerce.number().min(0).optional().nullable();
const dateField = z.coerce.date().optional().nullable();
const labels = z.array(z.string().trim().max(40)).max(20).optional();
const tags = z.array(z.string().trim().max(40)).max(20).optional();
const userIdList = z.array(objectId).max(50).optional();

const createTaskSchema = z
  .object({
    title,
    description,
    priority: z.enum(Object.values(TASK_PRIORITY)).optional(),
    visibility: z.enum(Object.values(TASK_VISIBILITY)).optional(),
    startDate: dateField,
    dueDate: dateField,
    estimatedHours,
    assignees: userIdList,
    owner: objectId.optional(),
    approvers: userIdList,
    labels,
    tags,
  })
  .refine((data) => !data.startDate || !data.dueDate || data.startDate <= data.dueDate, {
    message: 'Due date must be on or after the start date',
    path: ['dueDate'],
  });

const updateTaskSchema = z
  .object({
    title: title.optional(),
    description,
    status: z.enum(Object.values(TASK_STATUS)).optional(),
    priority: z.enum(Object.values(TASK_PRIORITY)).optional(),
    visibility: z.enum(Object.values(TASK_VISIBILITY)).optional(),
    startDate: dateField,
    dueDate: dateField,
    estimatedHours,
    assignees: userIdList,
    owner: objectId.optional(),
    approvers: userIdList,
    labels,
    tags,
  })
  .refine((data) => !data.startDate || !data.dueDate || data.startDate <= data.dueDate, {
    message: 'Due date must be on or after the start date',
    path: ['dueDate'],
  });

const listTasksQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(Object.values(TASK_STATUS)).optional(),
  priority: z.enum(Object.values(TASK_PRIORITY)).optional(),
  assignee: objectId.optional(),
  label: z.string().trim().max(40).optional(),
  visibility: z.enum(Object.values(TASK_VISIBILITY)).optional(),
  archived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  dueBefore: z.coerce.date().optional(),
  dueAfter: z.coerce.date().optional(),
  sortBy: z.enum(['title', 'createdAt', 'updatedAt', 'dueDate', 'priority', 'status']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const activityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const submitForReviewSchema = z.object({
  description: z.string().trim().min(1, 'Submission description is required').max(5000),
});

const reviewTaskSchema = z.object({
  action: z.enum(Object.values(TASK_REVIEW_ACTION)),
  remarks: z.string().trim().max(2000).optional(),
  submissionId: objectId.optional(),
});

module.exports = {
  activityQuerySchema,
  createTaskSchema,
  listTasksQuerySchema,
  reviewTaskSchema,
  submitForReviewSchema,
  updateTaskSchema,
};
