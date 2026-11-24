import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@bijliwala/contracts';
import type { AuthUser } from './auth.types';

export const IS_PUBLIC = 'auth:isPublic';
export const REQUIRED_PERMISSIONS = 'auth:permissions';
export const PLATFORM_ONLY = 'auth:platformOnly';

/** Opt a route out of JWT authentication. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Require ALL listed permissions (ANY scope). Resource-level scope checks happen in services/repositories. */
export const RequirePermissions = (...permissions: Permission[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
  return req.user;
});

/**
 * Restricts a route (or controller) to platform staff. Needed where a permission is shared with
 * portal roles (e.g. `job.read` is held by Company Admins too): /admin routes must never serve them.
 */
export const PlatformOnly = (): MethodDecorator & ClassDecorator => SetMetadata(PLATFORM_ONLY, true);
