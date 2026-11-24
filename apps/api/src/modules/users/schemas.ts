import { Schema, type Types } from 'mongoose';
import {
  SCOPE_TYPES,
  USER_STATUSES,
  USER_TYPES,
  type ScopeType,
  type UserStatus,
  type UserType,
} from '@bijliwala/contracts';
import type { EncryptedValue } from '../../core/crypto/field-crypto';

/* ---------------------------------------------------------------- users (DATABASE §4) */

export const USER_MODEL = 'User';

export interface UserDoc {
  _id: Types.ObjectId;
  name: string;
  userType: UserType;
  status: UserStatus;
  mobile?: string;
  mobileVerifiedAt?: Date;
  email?: string;
  emailVerifiedAt?: Date;
  passwordHash?: string;
  passwordReset?: { tokenHash: string; expiresAt: Date };
  mfa?: {
    enabled: boolean;
    secretEnc?: EncryptedValue;
    pendingSecretEnc?: EncryptedValue;
    lastUsedStep?: number;
    enrolledAt?: Date;
  };
  failedLoginCount: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  permVersion: number;
  consent: { termsVersion: string; acceptedAt: Date; ip?: string }[];
  statusReason?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const encryptedSchema = new Schema<EncryptedValue>(
  { ct: String, iv: String, tag: String, kv: Number },
  { _id: false },
);

export const userSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true },
    userType: { type: String, enum: USER_TYPES, required: true },
    status: { type: String, enum: USER_STATUSES, required: true, default: 'ACTIVE' },
    mobile: { type: String },
    mobileVerifiedAt: { type: Date },
    email: { type: String, lowercase: true, trim: true },
    emailVerifiedAt: { type: Date },
    passwordHash: { type: String },
    passwordReset: { type: new Schema({ tokenHash: String, expiresAt: Date }, { _id: false }) },
    mfa: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          secretEnc: encryptedSchema,
          pendingSecretEnc: encryptedSchema,
          lastUsedStep: Number,
          enrolledAt: Date,
        },
        { _id: false },
      ),
    },
    failedLoginCount: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
    permVersion: { type: Number, required: true, default: 1 },
    consent: {
      type: [new Schema({ termsVersion: String, acceptedAt: Date, ip: String }, { _id: false })],
      default: [],
    },
    statusReason: { type: String },
    version: { type: Number, required: true, default: 0 },
  },
  { collection: 'users', timestamps: true, versionKey: false },
);
userSchema.index({ mobile: 1 }, { unique: true, partialFilterExpression: { mobile: { $type: 'string' } } });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ userType: 1, status: 1, createdAt: -1 });
userSchema.index({ 'passwordReset.tokenHash': 1 }, { sparse: true });
userSchema.index({ name: 'text', email: 'text' });

/* ---------------------------------------------------------------- roles */

export const ROLE_MODEL = 'Role';

export interface RoleDoc {
  _id: Types.ObjectId;
  code: string;
  name: string;
  description?: string;
  scopeType: ScopeType;
  permissions: string[];
  isSystem: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const roleSchema = new Schema<RoleDoc>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    scopeType: { type: String, enum: SCOPE_TYPES, required: true },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, required: true, default: false },
    version: { type: Number, required: true, default: 0 },
  },
  { collection: 'roles', timestamps: true, versionKey: false },
);
roleSchema.index({ code: 1 }, { unique: true });

/* ---------------------------------------------------------------- role assignments */

export const ROLE_ASSIGNMENT_MODEL = 'RoleAssignment';

export interface RoleAssignmentDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  roleId: Types.ObjectId;
  roleCode: string;
  scope: {
    type: ScopeType;
    companyId?: Types.ObjectId;
    vendorId?: Types.ObjectId;
    siteIds?: Types.ObjectId[];
  };
  /** Normalised scope key used for uniqueness: "PLATFORM" | "COMPANY:<id>" | "VENDOR:<id>". */
  scopeKey: string;
  grantedBy: string;
  /** true until revoked; partial indexes cannot filter on `$exists: false`, so this flag is explicit. */
  active: boolean;
  revokedAt?: Date;
  revokedBy?: string;
  createdAt: Date;
}

export const roleAssignmentSchema = new Schema<RoleAssignmentDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    roleId: { type: Schema.Types.ObjectId, required: true },
    roleCode: { type: String, required: true },
    scope: {
      type: new Schema(
        {
          type: { type: String, enum: SCOPE_TYPES, required: true },
          companyId: Schema.Types.ObjectId,
          vendorId: Schema.Types.ObjectId,
          siteIds: { type: [Schema.Types.ObjectId], default: undefined },
        },
        { _id: false },
      ),
      required: true,
    },
    scopeKey: { type: String, required: true },
    grantedBy: { type: String, required: true },
    active: { type: Boolean, required: true, default: true },
    revokedAt: { type: Date },
    revokedBy: { type: String },
  },
  { collection: 'role_assignments', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
roleAssignmentSchema.index({ userId: 1, active: 1 });
roleAssignmentSchema.index({ roleId: 1, active: 1 });
roleAssignmentSchema.index({ roleCode: 1, active: 1 });
roleAssignmentSchema.index({ 'scope.companyId': 1 }, { sparse: true });
roleAssignmentSchema.index({ 'scope.vendorId': 1 }, { sparse: true });
// One active grant of a role per user per scope.
roleAssignmentSchema.index(
  { userId: 1, roleId: 1, scopeKey: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

export const USER_SCHEMAS = [
  { name: USER_MODEL, schema: userSchema },
  { name: ROLE_MODEL, schema: roleSchema },
  { name: ROLE_ASSIGNMENT_MODEL, schema: roleAssignmentSchema },
];
