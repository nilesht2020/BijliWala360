import { Injectable } from '@nestjs/common';
import type {
  CreateAdminUserInput,
  PageMeta,
  UserDetailView,
  UserListQuery,
  UserStatus,
  UserView,
} from '@skillconnect/contracts';
import type { AuditActor, AuditContext } from '../../core/audit/audit.service';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError } from '../../core/errors/domain-error';
import { roleAllowedForUserType } from './domain/access';
import { RolesService, toAssignmentView } from './roles.service';
import { toUserView, UsersService } from './users.service';

/** Admin-facing user management use cases that span users and role assignments. */
@Injectable()
export class UserAdminService {
  constructor(
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly txn: TransactionRunner,
  ) {}

  async list(query: UserListQuery): Promise<{ items: UserView[]; meta: PageMeta }> {
    const withRole = query.roleCode ? await this.roles.userIdsWithRole(query.roleCode) : undefined;
    const { items, meta } = await this.users.list(query, withRole);
    const codes = await this.roles.roleCodesByUser(items.map((u) => u._id));
    return { items: items.map((u) => toUserView(u, codes.get(u._id.toHexString()) ?? [])), meta };
  }

  async detail(id: string): Promise<UserDetailView> {
    const user = await this.users.getById(id);
    const assignments = await this.roles.activeAssignmentsFor(user._id);
    const roles = await this.roles.findByCodes(assignments.map((a) => a.roleCode));
    const names = new Map(roles.map((r) => [r.code, r.name]));
    return {
      ...toUserView(user, [...new Set(assignments.map((a) => a.roleCode))].sort()),
      assignments: assignments.map((a) => toAssignmentView(a, names.get(a.roleCode))),
      ...(user.lockedUntil && user.lockedUntil > new Date()
        ? { lockedUntil: user.lockedUntil.toISOString() }
        : {}),
    };
  }

  /**
   * Creates an admin user with platform roles in one transaction, then emails a single-use link to
   * choose a password. The new admin must enrol in TOTP MFA on first sign-in (FR-AUTH-02).
   */
  async createAdmin(
    input: CreateAdminUserInput,
    actor: AuditActor,
    ctx?: AuditContext,
  ): Promise<UserDetailView> {
    const roles = await this.roles.findByCodes(input.roleCodes);
    const missing = input.roleCodes.filter((c) => !roles.some((r) => r.code === c));
    if (missing.length) {
      throw new DomainError('VALIDATION_FAILED', `Unknown role(s): ${missing.join(', ')}`, [
        { field: 'roleCodes' },
      ]);
    }
    const invalid = roles.filter((r) => !roleAllowedForUserType(r, 'ADMIN'));
    if (invalid.length) {
      throw new DomainError(
        'ROLE_SCOPE_MISMATCH',
        `Not an administration role: ${invalid.map((r) => r.code).join(', ')}`,
        [{ field: 'roleCodes' }],
      );
    }

    const user = await this.txn.run(async (session) => {
      const created = await this.users.createAdmin(input, session);
      for (const code of input.roleCodes) {
        await this.roles.grant(
          created._id.toHexString(),
          { roleCode: code, scope: { type: 'PLATFORM' } },
          actor,
          ctx,
          session,
        );
      }
      return created;
    });
    await this.users.sendPasswordSetEmail(user, 'INVITE');
    return this.detail(user._id.toHexString());
  }

  async setStatus(
    id: string,
    status: UserStatus,
    reason: string,
    actor: AuditActor,
    ctx?: AuditContext,
  ): Promise<UserDetailView> {
    if (status !== 'ACTIVE' && (await this.roles.isLastSuperAdmin(id))) {
      throw new DomainError('LAST_SUPER_ADMIN', 'The last Super Admin cannot be suspended or deactivated.');
    }
    await this.users.setStatus(id, status, reason, actor, ctx);
    return this.detail(id);
  }
}
