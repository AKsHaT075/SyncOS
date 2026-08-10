const { z } = require('zod');
const { MEETING_REQUEST_STATUS } = require('../constants/meeting.constants');

const objectId = z.string().trim().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const createMeetingRequestSchema = z.object({
  topic: z.string().trim().min(2).max(200),
  reason: z.string().trim().min(2).max(2000),
  requestedMembers: z.array(objectId).max(100).optional(),
  preferredDate: z.coerce.date().optional().nullable(),
  preferredTime: z.string().trim().max(20).optional(),
});

const decisionSchema = z.object({
  remarks: z.string().trim().max(2000).optional(),
});

const scheduleDecisionSchema = z
  .object({
    remarks: z.string().trim().max(2000).optional(),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: 'End time must be after the start time',
    path: ['endTime'],
  });

const listMeetingRequestsQuerySchema = z.object({
  status: z.enum(Object.values(MEETING_REQUEST_STATUS)).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = {
  createMeetingRequestSchema,
  decisionSchema,
  listMeetingRequestsQuerySchema,
  scheduleDecisionSchema,
};
