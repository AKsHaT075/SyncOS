const { z } = require('zod');
const { ROLES } = require('../constants/roles');
const { password } = require('./auth.validation');

const email = z.string().trim().email().transform((value) => value.toLowerCase());

const inviteUserSchema = z.object({
  email,
  role: z.enum([ROLES.HR, ROLES.MANAGER, ROLES.EMPLOYEE]),
});

const acceptInvitationSchema = z.object({
  token: z.string().trim().min(32),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  password,
});

const listInvitationsQuerySchema = z.object({
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = {
  acceptInvitationSchema,
  inviteUserSchema,
  listInvitationsQuerySchema,
};
