import {
  isPermission,
  PERMISSIONS,
  type Permission,
  type RoleScopeInput,
  type ScopeType,
  type UserType,
} from '@skillconnect/contracts';
import type { ResolvedAccess, RoleScope } from '../../../core/auth/auth.types';

/** Role code that always carries every permission, including ones added after it was seeded. */
export const SUPER_ADMIN = 'SUPER_ADMIN';

export interface AssignmentLike {
  roleCode: string;
  scope: {
    type: string;
    companyId?: { toString(): string };
    vendorId?: { toString(): string };
    siteIds?: { toString(): string }[];
  };
}

export interface RoleLike {
  code: string;
  permissions: readonly string[];
}

export function scopeKeyOf(scope: RoleScopeInput): string {
  switch (scope.type) {
    case 'PLATFORM':
      return 'PLATFORM';
    case 'COMPANY':
      return `COMPANY:${scope.companyId}`;
    case 'VENDOR':
      return `VENDOR:${scope.vendorId}`;
  }
}

function toRoleScope(scope: AssignmentLike['scope']): RoleScope | null {
  if (scope.type === 'PLATFORM') return { type: 'PLATFORM' };
  if (scope.type === 'COMPANY' && scope.companyId) {
    return {
      type: 'COMPANY',
      companyId: scope.companyId.toString(),
      ...(scope.siteIds?.length ? { siteIds: scope.siteIds.map((s) => s.toString()) } : {}),
    };
  }
  if (scope.type === 'VENDOR' && scope.vendorId)
    return { type: 'VENDOR', vendorId: scope.vendorId.toString() };
  return null;
}

/**
 * Pure access resolution: the union of permissions of all active role assignments, the role codes,
 * and the distinct scopes. Unknown permission strings in the DB are ignored defensively.
 */
export function resolveAccess(
  assignments: readonly AssignmentLike[],
  roles: readonly RoleLike[],
): ResolvedAccess {
  const byCode = new Map(roles.map((r) => [r.code, r]));
  const permissions = new Set<Permission>();
  const roleCodes = new Set<string>();
  const scopes = new Map<string, RoleScope>();

  for (const a of assignments) {
    const role = byCode.get(a.roleCode);
    if (!role) continue;
    roleCodes.add(role.code);
    const perms: readonly string[] = role.code === SUPER_ADMIN ? PERMISSIONS : role.permissions;
    for (const p of perms) if (isPermission(p)) permissions.add(p);
    const scope = toRoleScope(a.scope);
    if (scope) scopes.set(JSON.stringify(scope), scope);
  }

  return { roleCodes: [...roleCodes].sort(), permissions, scopes: [...scopes.values()] };
}

/** Self-service roles that belong to a specific non-admin user type. */
const USER_TYPE_ROLES: Record<string, UserType> = {
  PROFESSIONAL: 'PROFESSIONAL',
  VENDOR_WORKER: 'VENDOR_WORKER',
};

/**
 * Which user types may hold a role:
 *  - PLATFORM roles are administration roles (ADMIN users), except the PROFESSIONAL role;
 *  - COMPANY roles go to COMPANY users;
 *  - VENDOR roles go to VENDOR users, except VENDOR_WORKER which goes to worker logins.
 */
export function roleAllowedForUserType(
  role: { code: string; scopeType: ScopeType },
  userType: UserType,
): boolean {
  const pinned = USER_TYPE_ROLES[role.code];
  if (pinned) return userType === pinned;
  switch (role.scopeType) {
    case 'PLATFORM':
      return userType === 'ADMIN';
    case 'COMPANY':
      return userType === 'COMPANY';
    case 'VENDOR':
      return userType === 'VENDOR';
  }
}
