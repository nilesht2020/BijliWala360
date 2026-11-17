import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type Model } from 'mongoose';
import {
  SYSTEM_ROLES,
  type CreateRoleInput,
  type GrantRoleInput,
  type RoleAssignmentView,
  type RoleScopeInput,
  type RoleView,
  type UpdateRoleInput,
} from '@skillconnect/contracts';
import { AuditService, type AuditActor, type AuditContext } from '../../core/audit/audit.service';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import type { ResolvedAccess } from '../../core/auth/auth.types';
import { resolveAccess, roleAllowedForUserType, scopeKeyOf, SUPER_ADMIN } from './domain/access';
import {
  ROLE_ASSIGNMENT_MODEL,
  ROLE_MODEL,
  USER_MODEL,
  type RoleAssignmentDoc,
  type RoleDoc,
  type UserDoc,
} from './schemas';
import { isObjectId } from './users.service';

export function toRoleView(r: RoleDoc, assignedUsers?: number): RoleView {
  return {
    id: r._id.toHexString(),
    code: r.code,
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    scopeType: r.scopeType,
    permissions: r.permissions as RoleView['permissions'],
    isSystem: r.isSystem,
    version: r.version,
    ...(assignedUsers !== undefined ? { assignedUsers } : {}),
  };
}

export function toAssignmentView(a: RoleAssignmentDoc, roleName?: string): RoleAssignmentView {
  const scope: RoleScopeInput =
    a.scope.type === 'COMPANY'
      ? {
          type: 'COMPANY',
          companyId: a.scope.companyId?.toHexString() ?? '',
          ...(a.scope.siteIds?.length ? { siteIds: a.scope.siteIds.map((s) => s.toHexString()) } : {}),
        }
      : a.scope.type === 'VENDOR'
        ? { type: 'VENDOR', vendorId: a.scope.vendorId?.toHexString() ?? '' }
        : { type: 'PLATFORM' };
  return {
    id: a._id.toHexString(),
    roleId: a.roleId.toHexString(),
    roleCode: a.roleCode,
    ...(roleName ? { roleName } : {}),
    scope,
    grantedBy: a.grantedBy,
    grantedAt: a.createdAt.toISOString(),
  };
}

/**
 * Roles are DB-configurable bundles of permission codes; system roles are seeded and cannot be
 * deleted (FR-USR-03). Any change that affects a user's access bumps their permVersion so that
 * cached permissions and outstanding access tokens are re-evaluated immediately.
 */
@Injectable()
export class RolesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    @InjectModel(ROLE_MODEL) private readonly roles: Model<RoleDoc>,
    @InjectModel(ROLE_ASSIGNMENT_MODEL) private readonly assignments: Model<RoleAssignmentDoc>,
    @InjectModel(USER_MODEL) private readonly users: Model<UserDoc>,
    private readonly txn: TransactionRunner,
    private readonly audit: AuditService,
  ) {}

  /** Inserts missing system roles. Never overwrites permissions an admin has edited. */
  async onApplicationBootstrap(): Promise<void> {
    await this.seedSystemRoles();
  }

  async seedSystemRoles(): Promise<void> {
    for (const role of SYSTEM_ROLES) {
      try {
        await this.roles.updateOne(
          { code: role.code },
          {
            $setOnInsert: {
              code: role.code,
              name: role.name,
              scopeType: role.scopeType,
              permissions: [...role.permissions],
              isSystem: true,
              version: 0,
            },
          },
          { upsert: true },
        );
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err; // concurrent seeding by api + worker
      }
    }
    this.logger.log(`System roles ensured (${SYSTEM_ROLES.length})`);
  }

  /* ---------------------------------------------------------------- roles */

  async list(): Promise<RoleView[]> {
    const [roles, counts] = await Promise.all([
      this.roles.find().sort({ isSystem: -1, code: 1 }).lean<RoleDoc[]>().exec(),
      this.assignments.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { active: true } },
        { $group: { _id: '$roleId', users: { $addToSet: '$userId' } } },
        { $project: { n: { $size: '$users' } } },
      ]),
    ]);
    const byRole = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
    return roles.map((r) => toRoleView(r, byRole.get(r._id.toHexString()) ?? 0));
  }

  async findByCodes(codes: string[]): Promise<RoleDoc[]> {
    return this.roles
      .find({ code: { $in: codes } })
      .lean<RoleDoc[]>()
      .exec();
  }

  async getById(id: string): Promise<RoleDoc> {
    const role = isObjectId(id) ? await this.roles.findById(id).lean<RoleDoc>().exec() : null;
    if (!role) throw new NotFoundError('Role', id);
    return role;
  }

  async create(input: CreateRoleInput, actor: AuditActor, ctx?: AuditContext): Promise<RoleView> {
    try {
      const [doc] = await this.roles.create([{ ...input, isSystem: false, version: 0 }]);
      const role = (doc as unknown as { toObject(): RoleDoc }).toObject();
      await this.audit.record({
        actor,
        action: 'role.create',
        entityType: 'Role',
        entityId: role._id.toHexString(),
        after: input,
        context: ctx,
      });
      return toRoleView(role, 0);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new DomainError('STATE_CONFLICT', `A role with code ${input.code} already exists.`, [
          { field: 'code' },
        ]);
      }
      throw err;
    }
  }

  async update(
    id: string,
    input: UpdateRoleInput,
    expectedVersion: number | undefined,
    actor: AuditActor,
    ctx?: AuditContext,
  ): Promise<RoleView> {
    const before = await this.getById(id);
    if (expectedVersion !== undefined && expectedVersion !== before.version) {
      throw new DomainError('VERSION_MISMATCH', 'This role was changed by someone else. Reload and retry.');
    }
    if (before.code === SUPER_ADMIN && input.permissions) {
      throw new DomainError('SYSTEM_ROLE_PROTECTED', 'Super Admin always has every permission.');
    }

    const updated = await this.txn.run(async (session) => {
      const doc = await this.roles
        .findOneAndUpdate(
          { _id: before._id, version: before.version },
          { $set: input, $inc: { version: 1 } },
          { new: true, session },
        )
        .lean<RoleDoc>()
        .exec();
      if (!doc)
        throw new DomainError('VERSION_MISMATCH', 'This role was changed by someone else. Reload and retry.');
      if (input.permissions) await this.bumpUsersWithRole(before._id, session);
      return doc;
    });

    await this.audit.record({
      actor,
      action: 'role.update',
      entityType: 'Role',
      entityId: id,
      before: { name: before.name, description: before.description, permissions: before.permissions },
      after: input,
      context: ctx,
    });
    return toRoleView(updated);
  }

  async remove(id: string, actor: AuditActor, ctx?: AuditContext): Promise<void> {
    const role = await this.getById(id);
    if (role.isSystem) throw new DomainError('SYSTEM_ROLE_PROTECTED', 'System roles cannot be deleted.');
    const inUse = await this.assignments.exists({ roleId: role._id, active: true });
    if (inUse) throw new DomainError('ROLE_IN_USE', 'Revoke this role from all users before deleting it.');
    await this.roles.deleteOne({ _id: role._id });
    await this.audit.record({
      actor,
      action: 'role.delete',
      entityType: 'Role',
      entityId: id,
      before: { code: role.code },
      context: ctx,
    });
  }

  /* ---------------------------------------------------------------- assignments */

  async activeAssignmentsFor(
    userId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<RoleAssignmentDoc[]> {
    const id = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    return this.assignments
      .find({ userId: id, active: true }, undefined, { session })
      .lean<RoleAssignmentDoc[]>()
      .exec();
  }

  /** Effective roles, permissions and scopes of a user (no caching). */
  async accessFor(userId: Types.ObjectId): Promise<ResolvedAccess> {
    const assignments = await this.activeAssignmentsFor(userId);
    const roles = await this.findByCodes([...new Set(assignments.map((a) => a.roleCode))]);
    return resolveAccess(assignments, roles);
  }

  /** Users holding a role in a given vendor/company scope (e.g. all Vendor Admins of a vendor). */
  async userIdsInScope(
    roleCode: string,
    scope: { vendorId?: string; companyId?: string },
  ): Promise<string[]> {
    const filter: Record<string, unknown> = { roleCode, active: true };
    if (scope.vendorId) filter['scope.vendorId'] = new Types.ObjectId(scope.vendorId);
    if (scope.companyId) filter['scope.companyId'] = new Types.ObjectId(scope.companyId);
    const ids = await this.assignments.distinct('userId', filter);
    return ids.map((i) => (i as Types.ObjectId).toHexString());
  }

  /** Active role assignments scoped to a company (its team members and their site limits). */
  async assignmentsInCompany(companyId: string, session?: ClientSession): Promise<RoleAssignmentDoc[]> {
    return this.assignments
      .find({ active: true, 'scope.companyId': new Types.ObjectId(companyId) }, undefined, { session })
      .lean<RoleAssignmentDoc[]>()
      .exec();
  }

  async userIdsWithRole(roleCode: string): Promise<Types.ObjectId[]> {
    const rows = await this.assignments.find({ roleCode, active: true }, { userId: 1 }).lean().exec();
    return rows.map((r) => r.userId);
  }

  /** Role codes per user, for list views. */
  async roleCodesByUser(userIds: Types.ObjectId[]): Promise<Map<string, string[]>> {
    const rows = await this.assignments
      .find({ userId: { $in: userIds }, active: true }, { userId: 1, roleCode: 1 })
      .lean()
      .exec();
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const key = r.userId.toHexString();
      map.set(key, [...new Set([...(map.get(key) ?? []), r.roleCode])].sort());
    }
    return map;
  }

  /**
   * Grants a role in a scope. Idempotent: an existing active identical grant is returned unchanged.
   * May join a caller's transaction (e.g. company creation grants COMPANY_ADMIN atomically).
   */
  async grant(
    userId: string,
    input: GrantRoleInput,
    actor: AuditActor,
    ctx?: AuditContext,
    session?: ClientSession,
  ): Promise<RoleAssignmentDoc> {
    const [role] = await this.roles
      .find({ code: input.roleCode }, undefined, { session })
      .lean<RoleDoc[]>()
      .exec();
    if (!role) throw new NotFoundError('Role', input.roleCode);
    if (role.scopeType !== input.scope.type) {
      throw new DomainError(
        'ROLE_SCOPE_MISMATCH',
        `${role.code} must be granted with a ${role.scopeType} scope.`,
        [{ field: 'scope.type' }],
      );
    }
    const user = isObjectId(userId)
      ? await this.users.findById(userId, undefined, { session }).lean<UserDoc>().exec()
      : null;
    if (!user) throw new NotFoundError('User', userId);
    if (!roleAllowedForUserType(role, user.userType)) {
      throw new DomainError(
        'ROLE_SCOPE_MISMATCH',
        `${role.code} cannot be granted to a ${user.userType} user.`,
        [{ field: 'roleCode' }],
      );
    }

    const scopeKey = scopeKeyOf(input.scope);
    const run = async (s: ClientSession) => {
      const existing = await this.assignments
        .findOne({ userId: user._id, roleId: role._id, scopeKey, active: true }, undefined, {
          session: s,
        })
        .lean<RoleAssignmentDoc>()
        .exec();
      if (existing) return existing;
      const scope =
        input.scope.type === 'COMPANY'
          ? {
              type: 'COMPANY' as const,
              companyId: new Types.ObjectId(input.scope.companyId),
              ...(input.scope.siteIds
                ? { siteIds: input.scope.siteIds.map((x) => new Types.ObjectId(x)) }
                : {}),
            }
          : input.scope.type === 'VENDOR'
            ? { type: 'VENDOR' as const, vendorId: new Types.ObjectId(input.scope.vendorId) }
            : { type: 'PLATFORM' as const };
      const [doc] = await this.assignments.create(
        [
          {
            userId: user._id,
            roleId: role._id,
            roleCode: role.code,
            scope,
            scopeKey,
            grantedBy: actor.userId ?? actor.system ?? 'system',
          },
        ],
        { session: s },
      );
      await this.users.updateOne({ _id: user._id }, { $inc: { permVersion: 1 } }, { session: s });
      await this.audit.record(
        {
          actor,
          action: 'role.grant',
          entityType: 'User',
          entityId: userId,
          after: { roleCode: role.code, scope: input.scope },
          context: ctx,
        },
        s,
      );
      return (doc as unknown as { toObject(): RoleAssignmentDoc }).toObject();
    };
    return this.txn.run(run, { session });
  }

  async revoke(userId: string, assignmentId: string, actor: AuditActor, ctx?: AuditContext): Promise<void> {
    if (!isObjectId(assignmentId) || !isObjectId(userId))
      throw new NotFoundError('Role assignment', assignmentId);
    await this.txn.run(async (session) => {
      const assignment = await this.assignments
        .findOne({ _id: assignmentId, userId, active: true }, undefined, { session })
        .lean<RoleAssignmentDoc>()
        .exec();
      if (!assignment) throw new NotFoundError('Role assignment', assignmentId);
      if (assignment.roleCode === SUPER_ADMIN) {
        const others = await this.assignments.countDocuments(
          { roleCode: SUPER_ADMIN, active: true, userId: { $ne: assignment.userId } },
          { session },
        );
        if (others === 0) throw new DomainError('LAST_SUPER_ADMIN', 'At least one Super Admin must remain.');
      }
      await this.assignments.updateOne(
        { _id: assignment._id },
        { $set: { active: false, revokedAt: new Date(), revokedBy: actor.userId ?? 'system' } },
        { session },
      );
      await this.users.updateOne({ _id: assignment.userId }, { $inc: { permVersion: 1 } }, { session });
      await this.audit.record(
        {
          actor,
          action: 'role.revoke',
          entityType: 'User',
          entityId: userId,
          before: { roleCode: assignment.roleCode, scopeKey: assignment.scopeKey },
          context: ctx,
        },
        session,
      );
    });
  }

  /** True when the user is the only active Super Admin (used to block suspension). */
  async isLastSuperAdmin(userId: string): Promise<boolean> {
    if (!isObjectId(userId)) return false;
    const holders = await this.assignments.distinct('userId', {
      roleCode: SUPER_ADMIN,
      active: true,
    });
    return holders.length === 1 && holders[0]?.toString() === userId;
  }

  private async bumpUsersWithRole(roleId: Types.ObjectId, session: ClientSession): Promise<void> {
    const userIds = await this.assignments.distinct('userId', { roleId, active: true }, { session });
    if (userIds.length > 0)
      await this.users.updateMany({ _id: { $in: userIds } }, { $inc: { permVersion: 1 } }, { session });
  }
}
