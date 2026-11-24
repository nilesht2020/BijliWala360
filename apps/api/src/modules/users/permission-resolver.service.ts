import { Injectable, Logger } from '@nestjs/common';
import { isPermission, type Permission } from '@bijliwala/contracts';
import type { PermissionResolver, ResolvedAccess, RoleScope } from '../../core/auth/auth.types';
import { InjectRedis, type RedisClient } from '../../core/redis/redis.module';
import { RolesService } from './roles.service';
import { UsersService } from './users.service';

const CACHE_TTL_SECONDS = 600;

interface CachedAccess {
  roleCodes: string[];
  permissions: string[];
  scopes: RoleScope[];
}

/**
 * Resolves a principal's roles, permissions and scopes (ARCHITECTURE §6.1). Every change to a
 * user's status, roles or role permissions bumps permVersion; the token's `pv` claim must equal the
 * current value, so such changes take effect on the very next request. The role/permission lookup
 * is cached in Redis under a permVersion-specific key, so it never needs explicit invalidation.
 */
@Injectable()
export class PermissionResolverService implements PermissionResolver {
  private readonly logger = new Logger(PermissionResolverService.name);

  constructor(
    private readonly users: UsersService,
    private readonly roles: RolesService,
    @InjectRedis() private readonly redis: RedisClient,
  ) {}

  async resolve(userId: string, permVersion: number): Promise<ResolvedAccess | null> {
    // Always validate status + permVersion against the database (one indexed read). Caching this
    // check would let a suspended user's or demoted admin's token live until the cache expired.
    const user = await this.users.findAuthState(userId);
    if (!user || user.status !== 'ACTIVE' || user.permVersion !== permVersion) return null;

    const key = `acl:${userId}:${permVersion}`;
    try {
      const cached = await this.redis.get(key);
      if (cached) return this.fromCache(JSON.parse(cached) as CachedAccess);
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'ACL cache read failed');
    }

    const access = await this.roles.accessFor(user._id);
    const toCache: CachedAccess = {
      roleCodes: access.roleCodes,
      permissions: [...access.permissions],
      scopes: access.scopes,
    };
    await this.redis.set(key, JSON.stringify(toCache), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return access;
  }

  private fromCache(c: CachedAccess): ResolvedAccess {
    return {
      roleCodes: c.roleCodes,
      permissions: new Set(c.permissions.filter(isPermission) as Permission[]),
      scopes: c.scopes,
    };
  }
}
