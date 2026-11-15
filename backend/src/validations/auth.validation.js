const { z } = require('zod');
const { ROLES } = require('../constants/roles');
const { PRESENCE } = require('../constants/presence.constants');

const email = z.string().trim().email().transform((value) => value.toLowerCase());

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters long')
  .max(128, 'Password is too long')
  .refine((value) => /[a-z]/.test(value), 'Password must contain a lowercase letter')
  .refine((value) => /[A-Z]/.test(value), 'Password must contain an uppercase letter')
  .refine((value) => /\d/.test(value), 'Password must contain a number');

const registerSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email,
  password,
});

const loginSchema = z.object({
  email,
  password: z.string().min(1),
});

const verifyOtpSchema = z.object({
  email,
  otp: z.string().trim().length(6),
});

const resendOtpSchema = z.object({
  email,
});

const forgotPasswordSchema = z.object({
  email,
});

const resetPasswordSchema = z.object({
  email,
  token: z.string().trim().min(32),
  password,
});

const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    skills: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: password })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, { message: 'The new password must be different', path: ['newPassword'] });

const updateRoleSchema = z.object({
  role: z.enum(Object.values(ROLES)),
});

// "offline" is derived, not settable — only ONLINE/DND are user choices.
const updatePresenceStatusSchema = z.object({
  status: z.enum(PRESENCE.SETTABLE_STATUSES),
});

module.exports = {
  changePasswordSchema,
  updateProfileSchema,
  forgotPasswordSchema,
  loginSchema,
  password,
  registerSchema,
  resendOtpSchema,
  resetPasswordSchema,
  updatePresenceStatusSchema,
  updateRoleSchema,
  verifyOtpSchema,
};