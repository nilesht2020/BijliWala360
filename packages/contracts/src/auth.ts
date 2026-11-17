import { z } from 'zod';
import { mobileSchema } from './common';
import type { UserType } from './enums';
import type { Permission } from './permissions';

/** User types that can self-register through mobile OTP (FR-AUTH-01). Admins are created by admins. */
export const SELF_SIGNUP_USER_TYPES = ['PROFESSIONAL', 'VENDOR', 'COMPANY'] as const;
export type SelfSignupUserType = (typeof SELF_SIGNUP_USER_TYPES)[number];

export const otpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
export const totpCodeSchema = z
  .string()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

/** Password policy (SRS §10.3): 12-128 chars with at least one letter and one digit. */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128, 'Use at most 128 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');

export const otpRequestSchema = z.object({ mobile: mobileSchema }).strict();
export type OtpRequest = z.infer<typeof otpRequestSchema>;

export const otpVerifySchema = z
  .object({ challengeId: z.string().min(1).max(64), code: otpCodeSchema })
  .strict();
export type OtpVerify = z.infer<typeof otpVerifySchema>;

export const signupSchema = z
  .object({
    signupToken: z.string().min(1),
    name: z.string().trim().min(2, 'Enter your full name').max(100),
    userType: z.enum(SELF_SIGNUP_USER_TYPES),
    email: emailSchema.optional(),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms to continue' }) }),
  })
  .strict();
export type SignupInput = z.infer<typeof signupSchema>;

export const adminLoginSchema = z
  .object({ email: emailSchema, password: z.string().min(1).max(128) })
  .strict();
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

export const passwordLoginSchema = adminLoginSchema;
export type PasswordLoginInput = AdminLoginInput;

export const mfaTokenSchema = z.object({ mfaToken: z.string().min(1) }).strict();
export const mfaVerifySchema = z.object({ mfaToken: z.string().min(1), totp: totpCodeSchema }).strict();
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();
export const resetPasswordSchema = z
  .object({ token: z.string().min(20).max(200), newPassword: passwordSchema })
  .strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z
  .object({ currentPassword: z.string().max(128).optional(), newPassword: passwordSchema })
  .strict();
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Session principal returned by GET /auth/me. */
export interface SessionScope {
  type: 'PLATFORM' | 'COMPANY' | 'VENDOR';
  companyId?: string;
  vendorId?: string;
  siteIds?: string[];
}

export interface SessionUser {
  id: string;
  name: string;
  userType: UserType;
  mobile?: string;
  email?: string;
  roleCodes: string[];
  permissions: Permission[];
  scopes: SessionScope[];
  mfaEnabled: boolean;
}

export interface OtpChallengeResponse {
  challengeId: string;
  expiresInSec: number;
  resendAfterSec: number;
  /** Development only (DEV_FIXED_OTP): the code to enter. Never present in production. */
  devCode?: string;
}

/** Every sign-in step returns one of these shapes. */
export type AuthStepResponse =
  | { status: 'AUTHENTICATED'; accessToken: string; expiresIn: number; user: SessionUser }
  | { status: 'SIGNUP_REQUIRED'; signupToken: string }
  | { status: 'MFA_REQUIRED'; mfaToken: string }
  | { status: 'MFA_ENROLLMENT_REQUIRED'; mfaToken: string };

export interface MfaEnrollmentResponse {
  otpauthUrl: string;
  secret: string;
}

export const REFRESH_COOKIE = 'sc_rt';
