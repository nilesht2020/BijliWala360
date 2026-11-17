import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type FilterQuery, type Model } from 'mongoose';
import type {
  PageMeta,
  SelfSignupUserType,
  UpdateUserInput,
  UserDetailView,
  UserListQuery,
  UserStatus,
  UserView,
} from '@skillconnect/contracts';
import { AuditService, type AuditActor, type AuditContext } from '../../core/audit/audit.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../../core/channels/channels';
import { AppConfig } from '../../core/config/app-config';
import { randomToken, sha256 } from '../../core/crypto/password';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { USER_MODEL, type UserDoc } from './schemas';

export const TERMS_VERSION = '2026-11';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const INVITE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 3 days for newly created admins

export function toUserView(u: UserDoc, roleCodes: string[] = []): UserView {
  return {
    id: u._id.toHexString(),
    name: u.name,
    userType: u.userType,
    status: u.status,
    ...(u.mobile ? { mobile: u.mobile } : {}),
    ...(u.email ? { email: u.email } : {}),
    mfaEnabled: !!u.mfa?.enabled,
    ...(u.lastLoginAt ? { lastLoginAt: u.lastLoginAt.toISOString() } : {}),
    createdAt: u.createdAt.toISOString(),
    roleCodes,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isObjectId(id: string): boolean {
  return /^[a-f0-9]{24}$/i.test(id);
}

/**
 * User identity store (FR-USR-*). Credential verification lives in the Auth module; this service
 * owns the user document, lockout counters, password/MFA fields and permVersion.
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectModel(USER_MODEL) private readonly users: Model<UserDoc>,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  async findById(id: string, session?: ClientSession): Promise<UserDoc | null> {
    if (!isObjectId(id)) return null;
    return this.users.findById(id, undefined, { session }).lean<UserDoc>().exec();
  }

  /** Minimal projection used on every authenticated request. */
  async findAuthState(id: string): Promise<Pick<UserDoc, '_id' | 'status' | 'permVersion'> | null> {
    if (!isObjectId(id)) return null;
    return this.users
      .findById(id, { status: 1, permVersion: 1 })
      .lean<Pick<UserDoc, '_id' | 'status' | 'permVersion'>>()
      .exec();
  }

  async getById(id: string): Promise<UserDoc> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundError('User', id);
    return user;
  }

  async findByMobile(mobile: string, session?: ClientSession): Promise<UserDoc | null> {
    return this.users.findOne({ mobile }, undefined, { session }).lean<UserDoc>().exec();
  }

  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.findOne({ email: email.toLowerCase() }).lean<UserDoc>().exec();
  }

  async findByIds(ids: string[]): Promise<UserDoc[]> {
    const valid = ids.filter(isObjectId).map((id) => new Types.ObjectId(id));
    return this.users
      .find({ _id: { $in: valid } })
      .lean<UserDoc[]>()
      .exec();
  }

  /** Mobile-OTP self sign-up (FR-AUTH-01). The mobile number is already verified by OTP. */
  async createSelfSignup(
    input: { mobile: string; name: string; userType: SelfSignupUserType; email?: string; ip?: string },
    session?: ClientSession,
  ): Promise<UserDoc> {
    const now = new Date();
    try {
      const [doc] = await this.users.create(
        [
          {
            name: input.name,
            userType: input.userType,
            status: 'ACTIVE',
            mobile: input.mobile,
            mobileVerifiedAt: now,
            ...(input.email ? { email: input.email } : {}),
            consent: [{ termsVersion: TERMS_VERSION, acceptedAt: now, ip: input.ip }],
          },
        ],
        { session },
      );
      return (doc as unknown as { toObject(): UserDoc }).toObject();
    } catch (err) {
      throw this.translateDuplicate(err);
    }
  }

  /**
   * Account created on someone's behalf (company team invite, lead conversion). The mobile is not
   * yet verified: the person proves it with the normal OTP sign-in, which finds this account.
   */
  async createInvited(
    input: { mobile: string; name: string; userType: 'COMPANY'; email?: string },
    session?: ClientSession,
  ): Promise<UserDoc> {
    try {
      const [doc] = await this.users.create(
        [
          {
            name: input.name,
            userType: input.userType,
            status: 'ACTIVE',
            mobile: input.mobile,
            ...(input.email ? { email: input.email } : {}),
          },
        ],
        { session },
      );
      return (doc as unknown as { toObject(): UserDoc }).toObject();
    } catch (err) {
      throw this.translateDuplicate(err);
    }
  }

  async createAdmin(
    input: { name: string; email: string; mobile?: string },
    session?: ClientSession,
  ): Promise<UserDoc> {
    try {
      const [doc] = await this.users.create(
        [
          {
            name: input.name,
            userType: 'ADMIN',
            status: 'ACTIVE',
            email: input.email,
            ...(input.mobile ? { mobile: input.mobile } : {}),
          },
        ],
        { session },
      );
      return (doc as unknown as { toObject(): UserDoc }).toObject();
    } catch (err) {
      throw this.translateDuplicate(err);
    }
  }

  async list(
    query: UserListQuery,
    userIdsWithRole?: Types.ObjectId[],
  ): Promise<{ items: UserDoc[]; meta: PageMeta }> {
    const filter: FilterQuery<UserDoc> = {};
    if (query.userType) filter.userType = query.userType;
    if (query.status) filter.status = query.status;
    if (userIdsWithRole) filter._id = { $in: userIdsWithRole };
    if (query.q) {
      const rx = new RegExp(escapeRegex(query.q), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { mobile: rx }];
    }
    const [items, total] = await Promise.all([
      this.users
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<UserDoc[]>()
        .exec(),
      this.users.countDocuments(filter),
    ]);
    return { items, meta: { page: query.page, pageSize: query.pageSize, total } };
  }

  async update(id: string, input: UpdateUserInput, actor: AuditActor, ctx?: AuditContext): Promise<UserDoc> {
    const before = await this.getById(id);
    let updated: UserDoc | null;
    try {
      updated = await this.users
        .findOneAndUpdate(
          { _id: before._id },
          {
            $set: {
              ...input,
              ...(input.email && input.email !== before.email ? { emailVerifiedAt: null } : {}),
            },
            $inc: { version: 1 },
          },
          { new: true },
        )
        .lean<UserDoc>()
        .exec();
    } catch (err) {
      throw this.translateDuplicate(err);
    }
    if (!updated) throw new NotFoundError('User', id);
    await this.audit.record({
      actor,
      action: 'user.update',
      entityType: 'User',
      entityId: id,
      before: { name: before.name, email: before.email },
      after: input,
      context: ctx,
    });
    return updated;
  }

  /**
   * Suspend / reactivate / deactivate. Bumping permVersion invalidates every access token
   * immediately; refresh is refused for non-active users (FR-AUTH-06).
   */
  async setStatus(
    id: string,
    status: UserStatus,
    reason: string,
    actor: AuditActor,
    ctx?: AuditContext,
  ): Promise<UserDoc> {
    const before = await this.getById(id);
    if (before.status === status) return before;
    if (actor.userId === id && status !== 'ACTIVE') {
      throw new DomainError('FORBIDDEN', 'You cannot suspend or deactivate your own account.');
    }
    const updated = await this.users
      .findOneAndUpdate(
        { _id: before._id, status: before.status },
        { $set: { status, statusReason: reason }, $inc: { permVersion: 1, version: 1 } },
        { new: true },
      )
      .lean<UserDoc>()
      .exec();
    if (!updated)
      throw new DomainError('STATE_CONFLICT', 'The user was changed by someone else. Reload and retry.');
    await this.audit.record({
      actor,
      action: `user.${status === 'ACTIVE' ? 'reactivate' : status === 'SUSPENDED' ? 'suspend' : 'deactivate'}`,
      entityType: 'User',
      entityId: id,
      before: { status: before.status },
      after: { status },
      reason,
      context: ctx,
    });
    return updated;
  }

  async bumpPermVersion(userIds: Types.ObjectId[], session?: ClientSession): Promise<void> {
    if (userIds.length === 0) return;
    await this.users.updateMany({ _id: { $in: userIds } }, { $inc: { permVersion: 1 } }, { session });
  }

  /* ---------------------------------------------------------------- login bookkeeping */

  async recordLoginSuccess(id: Types.ObjectId): Promise<void> {
    await this.users.updateOne(
      { _id: id },
      { $set: { lastLoginAt: new Date(), failedLoginCount: 0 }, $unset: { lockedUntil: 1 } },
    );
  }

  /** Increments failures; locks the account once `maxFailures` is reached. Returns true when locked. */
  async recordLoginFailure(
    id: Types.ObjectId,
    maxFailures: number,
    lockoutMinutes: number,
  ): Promise<boolean> {
    const updated = await this.users
      .findOneAndUpdate({ _id: id }, { $inc: { failedLoginCount: 1 } }, { new: true })
      .lean<UserDoc>()
      .exec();
    if (updated && updated.failedLoginCount >= maxFailures) {
      await this.users.updateOne(
        { _id: id },
        { $set: { lockedUntil: new Date(Date.now() + lockoutMinutes * 60_000), failedLoginCount: 0 } },
      );
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- password & MFA fields */

  async setPasswordHash(id: Types.ObjectId, passwordHash: string): Promise<void> {
    await this.users.updateOne(
      { _id: id },
      {
        $set: { passwordHash, failedLoginCount: 0 },
        $unset: { passwordReset: 1, lockedUntil: 1 },
        $inc: { permVersion: 1, version: 1 },
      },
    );
  }

  /** Creates a single-use password set/reset token; only its hash is stored. */
  async issuePasswordResetToken(id: Types.ObjectId, ttlMs = RESET_TOKEN_TTL_MS): Promise<string> {
    const token = randomToken();
    await this.users.updateOne(
      { _id: id },
      { $set: { passwordReset: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } } },
    );
    return token;
  }

  /** Atomically consumes a reset token; returns the user or null when invalid/expired. */
  async consumePasswordResetToken(token: string): Promise<UserDoc | null> {
    return this.users
      .findOneAndUpdate(
        { 'passwordReset.tokenHash': sha256(token), 'passwordReset.expiresAt': { $gt: new Date() } },
        { $unset: { passwordReset: 1 } },
        { new: true },
      )
      .lean<UserDoc>()
      .exec();
  }

  async setPendingMfaSecret(
    id: Types.ObjectId,
    secretEnc: NonNullable<UserDoc['mfa']>['pendingSecretEnc'],
  ): Promise<void> {
    await this.users.updateOne(
      { _id: id },
      { $set: { 'mfa.pendingSecretEnc': secretEnc, 'mfa.enabled': false } },
    );
  }

  async activateMfa(id: Types.ObjectId, step: number): Promise<boolean> {
    const user = await this.users.findById(id).lean<UserDoc>().exec();
    if (!user?.mfa?.pendingSecretEnc) return false;
    const res = await this.users.updateOne(
      { _id: id, 'mfa.pendingSecretEnc': { $exists: true } },
      {
        $set: {
          'mfa.enabled': true,
          'mfa.secretEnc': user.mfa.pendingSecretEnc,
          'mfa.lastUsedStep': step,
          'mfa.enrolledAt': new Date(),
        },
        $unset: { 'mfa.pendingSecretEnc': 1 },
      },
    );
    return res.modifiedCount === 1;
  }

  /** TOTP replay protection: accepts a time step only if it is newer than the last one used. */
  async claimTotpStep(id: Types.ObjectId, step: number): Promise<boolean> {
    const res = await this.users.updateOne(
      {
        _id: id,
        'mfa.enabled': true,
        $or: [{ 'mfa.lastUsedStep': { $lt: step } }, { 'mfa.lastUsedStep': { $exists: false } }],
      },
      { $set: { 'mfa.lastUsedStep': step } },
    );
    return res.modifiedCount === 1;
  }

  async resetMfa(id: string, actor: AuditActor, ctx?: AuditContext): Promise<void> {
    const user = await this.getById(id);
    await this.users.updateOne({ _id: user._id }, { $unset: { mfa: 1 }, $inc: { permVersion: 1 } });
    await this.audit.record({
      actor,
      action: 'user.mfa_reset',
      entityType: 'User',
      entityId: id,
      context: ctx,
    });
  }

  /* ---------------------------------------------------------------- emails */

  async sendPasswordSetEmail(user: UserDoc, kind: 'INVITE' | 'RESET'): Promise<void> {
    if (!user.email) return;
    const token = await this.issuePasswordResetToken(
      user._id,
      kind === 'INVITE' ? INVITE_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS,
    );
    const link = `${this.config.env.WEB_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
    const subject =
      kind === 'INVITE' ? 'Set up your SkillConnect admin account' : 'Reset your SkillConnect password';
    const intro =
      kind === 'INVITE'
        ? `Hello ${user.name}, an administrator account has been created for you.`
        : `Hello ${user.name}, we received a request to reset your password.`;
    await this.email.send({
      to: user.email,
      subject,
      html: `<p>${intro}</p><p><a href="${link}">Choose a password</a>. This link can be used once and expires soon.</p><p>If you did not expect this email you can ignore it.</p>`,
    });
  }

  private translateDuplicate(err: unknown): unknown {
    if ((err as { code?: number }).code === 11000) {
      const key = JSON.stringify((err as { keyPattern?: unknown }).keyPattern ?? {});
      const field = key.includes('email') ? 'email' : key.includes('mobile') ? 'mobile number' : 'details';
      return new DomainError('DUPLICATE_ACCOUNT', `An account with this ${field} already exists.`, [
        { field: field === 'mobile number' ? 'mobile' : field },
      ]);
    }
    return err;
  }
}

export type { UserDetailView };
