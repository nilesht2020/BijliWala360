import { Schema, type Types } from 'mongoose';

/* ------------------------------------------------------------ otp_challenges (DATABASE §4) */

export const OTP_CHALLENGE_MODEL = 'OtpChallenge';

export interface OtpChallengeDoc {
  _id: Types.ObjectId;
  mobile: string;
  purpose: 'LOGIN';
  codeHash: string;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  consumedAt?: Date;
  supersededAt?: Date;
  ip?: string;
  createdAt: Date;
}

export const otpChallengeSchema = new Schema<OtpChallengeDoc>(
  {
    mobile: { type: String, required: true },
    purpose: { type: String, enum: ['LOGIN'], required: true, default: 'LOGIN' },
    codeHash: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date },
    supersededAt: { type: Date },
    ip: { type: String },
  },
  { collection: 'otp_challenges', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
otpChallengeSchema.index({ mobile: 1, createdAt: -1 });
otpChallengeSchema.index({ ip: 1, createdAt: -1 });
// Documents disappear one hour after they expire.
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

/* ------------------------------------------------------------ refresh_tokens */

export const REFRESH_TOKEN_MODEL = 'RefreshToken';

export type RevokeReason =
  | 'ROTATED'
  | 'LOGOUT'
  | 'REUSE_DETECTED'
  | 'ADMIN'
  | 'PASSWORD_CHANGED'
  | 'USER_INACTIVE';

export interface RefreshTokenDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt?: Date;
  revokedReason?: RevokeReason;
  userAgent?: string;
  ip?: string;
  createdAt: Date;
}

export const refreshTokenSchema = new Schema<RefreshTokenDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    familyId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedReason: { type: String },
    userAgent: { type: String },
    ip: { type: String },
  },
  { collection: 'refresh_tokens', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ userId: 1, familyId: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AUTH_SCHEMAS = [
  { name: OTP_CHALLENGE_MODEL, schema: otpChallengeSchema },
  { name: REFRESH_TOKEN_MODEL, schema: refreshTokenSchema },
];
