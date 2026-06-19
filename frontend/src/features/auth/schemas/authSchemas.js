import { z } from "zod";

export const emailSchema = z.string().trim().email("Enter a valid email address").transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters long")
  .max(128, "Password is too long")
  .refine((value) => /[a-z]/.test(value), "Password must contain a lowercase letter")
  .refine((value) => /[A-Z]/.test(value), "Password must contain an uppercase letter")
  .refine((value) => /\d/.test(value), "Password must contain a number");

export const registerSchema = z.object({
  email: emailSchema,
  firstName: z.string().trim().min(1, "First name is required").max(80, "First name is too long"),
  lastName: z.string().trim().min(1, "Last name is required").max(80, "Last name is too long"),
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export const verifyEmailSchema = z.object({
  email: emailSchema,
  otp: z.string().trim().length(6, "OTP must be 6 digits"),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  token: z.string().trim().min(16, "Reset token is required"),
});
