const { z } = require('zod');
const { MEETING_STATUS } = require('../constants/meeting.constants');

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const topic = z.string().trim().min(2).max(200);
const description = z.string().trim().max(5000).optional();
const participantList = z.array(objectId).max(100).optional();

const createMeetingSchema = z
  .object({
    topic,
    description,
    participants: participantList,
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: 'End time must be after the start time',
    path: ['endTime'],
  })
  .refine((data) => data.startTime.getTime() >= Date.now() - 60 * 1000, {
    message: 'Start time cannot be in the past',
    path: ['startTime'],
  });

const instantMeetingSchema = z.object({
  topic,
  description,
  participants: participantList,
});

const updateMeetingSchema = z
  .object({
    topic: topic.optional(),
    description,
    startTime: z.coerce.date().optional(),
    endTime: z.coerce.date().optional().nullable(),
  })
  .refine((data) => !data.startTime || !data.endTime || data.endTime > data.startTime, {
    message: 'End time must be after the start time',
    path: ['endTime'],
  });

const addParticipantsSchema = z.object({
  participants: z.array(objectId).min(1).max(100),
});

const listMeetingsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(Object.values(MEETING_STATUS)).optional(),
  sortBy: z.enum(['startTime', 'createdAt', 'updatedAt', 'topic']).default('startTime'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const activityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = {
  activityQuerySchema,
  addParticipantsSchema,
  createMeetingSchema,
  instantMeetingSchema,
  listMeetingsQuerySchema,
  updateMeetingSchema,
};
