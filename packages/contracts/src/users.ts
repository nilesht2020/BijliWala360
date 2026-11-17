import { z } from 'zod';
import { emailSchema } from './auth';
import { mobileSchema, objectIdSchema, paginationQuerySchema } from './common';
import {
  SCOPE_TYPES,
  USER_STATUSES,
  USER_TYPES,
  type ScopeType,
  type UserStatus,
  type UserType,
} from './enums';
import { PERMISSIONS, type Permission } from './permissions';

export const userListQuerySchema = paginationQuerySchema
  .extend({
    q: z.string().trim().max(100).optional(),
    userType: z.enum(USER_TYPES).optional(),
    status: z.enum(USER_STATUSES).optional(),
    roleCode: z.string().max(50).optional(),
  })
  .strict();
export type UserListQuery = z.infer<typeof userListQuerySchema>;

/** Admin users are created by an admin; they receive an email link to set their password. */
export const createAdminUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: emailSchema,
    mobile: mobileSchema.optional(),
    roleCodes: z.array(z.string().max(50)).min(1, 'Assign at least one role').max(10),
  })
  .strict();
export type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>;

export const updateUserSchema = z
  .object({ name: z.string().trim().min(2).max(100).optional(), email: emailSchema.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const updateMeSchema = z.object({ name: z.string().trim().min(2).max(100) }).strict();

export const statusChangeSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const roleScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PLATFORM') }).strict(),
  z
    .object({
      type: z.literal('COMPANY'),
      companyId: objectIdSchema,
      siteIds: z.array(objectIdSchema).max(100).optional(),
    })
    .strict(),
  z.object({ type: z.literal('VENDOR'), vendorId: objectIdSchema }).strict(),
]);
export type RoleScopeInput = z.infer<typeof roleScopeSchema>;

export const roleCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{2,49}$/, 'Use UPPER_SNAKE_CASE, 3-50 characters');

export const createRoleSchema = z
  .object({
    code: roleCodeSchema,
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).optional(),
    scopeType: z.enum(SCOPE_TYPES),
    permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
  })
  .strict();
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(500).optional(),
    permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(),
  })
  .strict();
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const grantRoleSchema = z.object({ roleCode: z.string().max(50), scope: roleScopeSchema }).strict();
export type GrantRoleInput = z.infer<typeof grantRoleSchema>;

export interface RoleView {
  id: string;
  code: string;
  name: string;
  description?: string;
  scopeType: ScopeType;
  permissions: Permission[];
  isSystem: boolean;
  version: number;
  assignedUsers?: number;
}

export interface RoleAssignmentView {
  id: string;
  roleId: string;
  roleCode: string;
  roleName?: string;
  scope: RoleScopeInput;
  grantedBy: string;
  grantedAt: string;
}

export interface UserView {
  id: string;
  name: string;
  userType: UserType;
  status: UserStatus;
  mobile?: string;
  email?: string;
  mfaEnabled: boolean;
  lastLoginAt?: string;
  createdAt: string;
  roleCodes: string[];
}

export interface UserDetailView extends UserView {
  assignments: RoleAssignmentView[];
  lockedUntil?: string;
}
