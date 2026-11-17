import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Permission } from '@skillconnect/contracts';
import { DomainError, ForbiddenError } from '../errors/domain-error';
import {
  PERMISSION_RESOLVER,
  type AccessTokenClaims,
  type AuthUser,
  type PermissionResolver,
} from './auth.types';
import { IS_PUBLIC, PLATFORM_ONLY, REQUIRED_PERMISSIONS } from './decorators';

type AuthedRequest = Request & { user?: AuthUser };

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/** Global guard: verifies the access JWT and loads the principal's roles/permissions/scopes. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(PERMISSION_RESOLVER) private readonly resolver: PermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req);
    if (!token) throw new DomainError('UNAUTHENTICATED', 'Authentication is required.');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
    } catch (err) {
      if (err instanceof TokenExpiredError)
        throw new DomainError('TOKEN_EXPIRED', 'Access token has expired.');
      throw new DomainError('UNAUTHENTICATED', 'Invalid access token.');
    }

    const access = await this.resolver.resolve(claims.sub, claims.pv);
    if (!access) throw new DomainError('UNAUTHENTICATED', 'Session is no longer valid.');

    req.user = { id: claims.sub, userType: claims.typ, permVersion: claims.pv, ...access };
    return true;
  }
}

/** Global guard: enforces @RequirePermissions metadata. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    const platformOnly = this.reflector.getAllAndOverride<boolean | undefined>(PLATFORM_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if ((!required || required.length === 0) && !platformOnly) return true;
    const user = context.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw new DomainError('UNAUTHENTICATED', 'Authentication is required.');
    if (platformOnly && !isPlatformUser(user)) throw new ForbiddenError();
    if (!required) return true;
    const missing = required.filter((p) => !user.permissions.has(p));
    if (missing.length > 0) throw new ForbiddenError();
    return true;
  }
}

export function hasPermission(user: AuthUser | undefined, permission: Permission): boolean {
  return !!user && user.permissions.has(permission);
}

/** Helpers for repository-level scope filtering (IDOR defence-in-depth, ARCHITECTURE §6.1). */
export function companyIdsOf(user: AuthUser): string[] {
  return user.scopes.flatMap((s) => (s.type === 'COMPANY' ? [s.companyId] : []));
}

export function vendorIdsOf(user: AuthUser): string[] {
  return user.scopes.flatMap((s) => (s.type === 'VENDOR' ? [s.vendorId] : []));
}

export function isPlatformUser(user: AuthUser): boolean {
  return user.scopes.some((s) => s.type === 'PLATFORM') && user.userType === 'ADMIN';
}
