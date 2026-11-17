import type { Permission, ScopeType, UserType } from '@skillconnect/contracts';

/** Claims carried in the access JWT (ARCHITECTURE §6.1). Permissions are NOT in the token. */
export interface AccessTokenClaims {
  sub: string;
  typ: UserType;
  pv: number; // permVersion
}

export type RoleScope =
  | { type: Extract<ScopeType, 'PLATFORM'> }
  | { type: Extract<ScopeType, 'COMPANY'>; companyId: string; siteIds?: string[] }
  | { type: Extract<ScopeType, 'VENDOR'>; vendorId: string };

export interface ResolvedAccess {
  roleCodes: string[];
  permissions: Set<Permission>;
  scopes: RoleScope[];
}

/** The authenticated principal attached to `req.user`. */
export interface AuthUser extends ResolvedAccess {
  id: string;
  userType: UserType;
  permVersion: number;
}

export const PERMISSION_RESOLVER = Symbol('PERMISSION_RESOLVER');

/** Implemented by the Users module (Phase 2): resolves roles/permissions/scopes, Redis-cached by permVersion. */
export interface PermissionResolver {
  resolve(userId: string, permVersion: number): Promise<ResolvedAccess | null>;
}
