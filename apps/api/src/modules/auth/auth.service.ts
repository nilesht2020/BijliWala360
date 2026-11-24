import { Injectable } from '@nestjs/common';
import type {
  AuthStepResponse,
  MfaEnrollmentResponse,
  OtpChallengeResponse,
  SessionUser,
  SignupInput,
} from '@bijliwala/contracts';
import { AuditService, type AuditActor, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { BusinessConfigService } from '../../core/business-config/business-config.service';
import { FieldCrypto } from '../../core/crypto/field-crypto';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../../core/crypto/password';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError } from '../../core/errors/domain-error';
import { NotificationsService } from '../notifications/notifications.service';
import type { UserDoc } from '../users/schemas';
import { RolesService } from '../users/roles.service';
import { UsersService } from '../users/users.service';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './domain/totp';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';

/** Result of a completed sign-in: the response body plus the refresh token for the cookie. */
export interface SignInResult {
  response: AuthStepResponse;
  refreshToken?: string;
}

const INVALID_CREDENTIALS = 'The email or password is incorrect.';

function maskMobile(mobile: string): string {
  return `${mobile.slice(0, 3)}******${mobile.slice(-4)}`;
}

/**
 * Sign-in flows (SRS §3.1):
 *  - providers / company users: mobile OTP -> (sign-up details on first login) -> session;
 *  - admins: email + password -> TOTP (enrolment enforced on first login) -> session;
 *  - company users may also use email + password once they have set one.
 * Every authentication event is audited (FR-AUTH-09).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: BusinessConfigService,
    private readonly crypto: FieldCrypto,
    private readonly txn: TransactionRunner,
  ) {}

  /* ------------------------------------------------------------------ OTP */

  async requestOtp(mobile: string, ctx: AuditContext): Promise<OtpChallengeResponse> {
    const res = await this.otp.request(mobile, ctx.ip);
    await this.audit.record({
      actor: { system: 'auth' },
      action: 'auth.otp_requested',
      entityType: 'Mobile',
      entityId: maskMobile(mobile),
      context: ctx,
    });
    return res;
  }

  async verifyOtp(challengeId: string, code: string, ctx: AuditContext): Promise<SignInResult> {
    let mobile: string;
    try {
      mobile = await this.otp.verify(challengeId, code);
    } catch (err) {
      await this.audit.record({
        actor: { system: 'auth' },
        action: 'auth.otp_failed',
        entityType: 'OtpChallenge',
        entityId: challengeId,
        context: ctx,
      });
      throw err;
    }
    const user = await this.users.findByMobile(mobile);
    if (!user) {
      return {
        response: {
          status: 'SIGNUP_REQUIRED',
          signupToken: await this.sessions.signStepToken('signup', { mobile }),
        },
      };
    }
    if (user.userType === 'ADMIN') {
      // Administrators must always pass password + TOTP; OTP alone never grants admin access.
      throw new DomainError(
        'INVALID_CREDENTIALS',
        'Administrators sign in with email, password and authenticator code.',
      );
    }
    this.assertActive(user);
    return this.completeSignIn(user, 'otp', ctx);
  }

  async signup(input: SignupInput, ctx: AuditContext): Promise<SignInResult> {
    const { mobile } = await this.sessions.verifyStepToken('signup', input.signupToken);
    const user = await this.txn.run(async (session) => {
      const created = await this.users.createSelfSignup(
        {
          mobile,
          name: input.name,
          userType: input.userType,
          ...(input.email ? { email: input.email } : {}),
          ip: ctx.ip,
        },
        session,
      );
      const actor: AuditActor = { userId: created._id.toHexString(), userType: created.userType };
      // Individual professionals get their self-service role immediately. Vendor and company admin
      // roles are scoped to an organisation and are granted when that organisation is created.
      if (created.userType === 'PROFESSIONAL') {
        await this.roles.grant(
          created._id.toHexString(),
          { roleCode: 'PROFESSIONAL', scope: { type: 'PLATFORM' } },
          actor,
          ctx,
          session,
        );
      }
      await this.audit.record(
        {
          actor,
          action: 'auth.signup',
          entityType: 'User',
          entityId: created._id.toHexString(),
          after: { userType: created.userType },
          context: ctx,
        },
        session,
      );
      await this.notifications.request(
        {
          eventType: 'account.created',
          priority: 'NORMAL',
          recipients: [{ userId: created._id.toHexString() }],
          data: { name: created.name },
        },
        session,
      );
      return created;
    });
    const fresh = (await this.users.findById(user._id.toHexString())) ?? user;
    return this.completeSignIn(fresh, 'signup', ctx);
  }

  /* ------------------------------------------------------------------ passwords */

  /** Admin step 1: verify the password; the session is only issued after TOTP (FR-AUTH-02). */
  async adminLogin(email: string, password: string, ctx: AuditContext): Promise<SignInResult> {
    const user = await this.checkPassword(email, password, ['ADMIN'], ctx);
    const mfaToken = await this.sessions.signStepToken('mfa', {
      sub: user._id.toHexString(),
      pv: user.permVersion,
    });
    return { response: { status: user.mfa?.enabled ? 'MFA_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED', mfaToken } };
  }

  /** Company users who have set a password may use it instead of OTP (FR-AUTH-03). */
  async passwordLogin(email: string, password: string, ctx: AuditContext): Promise<SignInResult> {
    const user = await this.checkPassword(email, password, ['COMPANY'], ctx);
    return this.completeSignIn(user, 'password', ctx);
  }

  private async checkPassword(
    email: string,
    password: string,
    allowed: UserDoc['userType'][],
    ctx: AuditContext,
  ): Promise<UserDoc> {
    const user = await this.users.findByEmail(email);
    if (!user || !allowed.includes(user.userType) || !user.passwordHash) {
      await verifyPassword(password, await dummyPasswordHash()); // equalise timing
      await this.audit.record({
        actor: { system: 'auth' },
        action: 'auth.login_failed',
        entityType: 'Email',
        entityId: email,
        context: ctx,
      });
      throw new DomainError('INVALID_CREDENTIALS', INVALID_CREDENTIALS);
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new DomainError(
        'ACCOUNT_LOCKED',
        'Too many failed attempts. Try again later or reset your password.',
      );
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      await this.registerFailure(user, ctx);
      throw new DomainError('INVALID_CREDENTIALS', INVALID_CREDENTIALS);
    }
    this.assertActive(user);
    return user;
  }

  private async registerFailure(user: UserDoc, ctx: AuditContext): Promise<void> {
    const [max, minutes] = await Promise.all([
      this.config.get('auth.maxFailedLogins'),
      this.config.get('auth.lockoutMinutes'),
    ]);
    const locked = await this.users.recordLoginFailure(user._id, max, minutes);
    await this.audit.record({
      actor: { userId: user._id.toHexString(), userType: user.userType },
      action: locked ? 'auth.account_locked' : 'auth.login_failed',
      entityType: 'User',
      entityId: user._id.toHexString(),
      context: ctx,
    });
    if (locked)
      throw new DomainError(
        'ACCOUNT_LOCKED',
        'Too many failed attempts. Try again later or reset your password.',
      );
  }

  async forgotPassword(email: string, ctx: AuditContext): Promise<void> {
    const user = await this.users.findByEmail(email);
    // Always succeed from the caller's point of view: never reveal whether an account exists.
    if (!user || user.status !== 'ACTIVE' || !['ADMIN', 'COMPANY'].includes(user.userType)) return;
    await this.users.sendPasswordSetEmail(user, 'RESET');
    await this.audit.record({
      actor: { system: 'auth' },
      action: 'auth.password_reset_requested',
      entityType: 'User',
      entityId: user._id.toHexString(),
      context: ctx,
    });
  }

  async resetPassword(token: string, newPassword: string, ctx: AuditContext): Promise<void> {
    const user = await this.users.consumePasswordResetToken(token);
    if (!user)
      throw new DomainError('UNAUTHENTICATED', 'This link is invalid or has expired. Request a new one.');
    await this.users.setPasswordHash(user._id, await hashPassword(newPassword));
    await this.sessions.revokeAllForUser(user._id, 'PASSWORD_CHANGED');
    await this.audit.record({
      actor: { userId: user._id.toHexString(), userType: user.userType },
      action: 'auth.password_reset',
      entityType: 'User',
      entityId: user._id.toHexString(),
      context: ctx,
    });
  }

  /** Changes the caller's password, ends all other sessions and returns a fresh one. */
  async changePassword(
    principal: AuthUser,
    currentPassword: string | undefined,
    newPassword: string,
    ctx: AuditContext,
  ): Promise<SignInResult> {
    const user = await this.users.getById(principal.id);
    if (user.passwordHash) {
      if (!currentPassword || !(await verifyPassword(currentPassword, user.passwordHash))) {
        throw new DomainError('INVALID_CREDENTIALS', 'Your current password is incorrect.', [
          { field: 'currentPassword' },
        ]);
      }
    }
    await this.users.setPasswordHash(user._id, await hashPassword(newPassword));
    await this.sessions.revokeAllForUser(user._id, 'PASSWORD_CHANGED');
    await this.audit.record({
      actor: { userId: principal.id, userType: principal.userType },
      action: 'auth.password_changed',
      entityType: 'User',
      entityId: principal.id,
      context: ctx,
    });
    return this.completeSignIn(await this.users.getById(principal.id), 'password_change', ctx);
  }

  /* ------------------------------------------------------------------ TOTP MFA */

  private async mfaSubject(mfaToken: string): Promise<UserDoc> {
    const claims = await this.sessions.verifyStepToken('mfa', mfaToken);
    const user = await this.users.findById(claims.sub);
    if (!user || user.permVersion !== claims.pv || user.userType !== 'ADMIN') {
      throw new DomainError('UNAUTHENTICATED', 'This sign-in step has expired. Please start again.');
    }
    this.assertActive(user);
    return user;
  }

  async startMfaEnrollment(mfaToken: string): Promise<MfaEnrollmentResponse> {
    const user = await this.mfaSubject(mfaToken);
    if (user.mfa?.enabled)
      throw new DomainError('STATE_CONFLICT', 'Two-factor authentication is already set up.');
    const secret = generateTotpSecret();
    await this.users.setPendingMfaSecret(user._id, this.crypto.encrypt(secret));
    return { secret, otpauthUrl: otpauthUrl(secret, user.email ?? user.name) };
  }

  async confirmMfaEnrollment(mfaToken: string, code: string, ctx: AuditContext): Promise<SignInResult> {
    const user = await this.mfaSubject(mfaToken);
    const pending = user.mfa?.pendingSecretEnc;
    if (!pending) throw new DomainError('STATE_CONFLICT', 'Start two-factor setup first.');
    const step = verifyTotp(this.crypto.decrypt(pending), code);
    if (step === null) {
      await this.registerFailure(user, ctx);
      throw new DomainError(
        'MFA_INVALID',
        'That code is not valid. Check the time on your device and try again.',
      );
    }
    if (!(await this.users.activateMfa(user._id, step)))
      throw new DomainError('STATE_CONFLICT', 'Start two-factor setup again.');
    await this.audit.record({
      actor: { userId: user._id.toHexString(), userType: user.userType },
      action: 'auth.mfa_enrolled',
      entityType: 'User',
      entityId: user._id.toHexString(),
      context: ctx,
    });
    return this.completeSignIn(await this.users.getById(user._id.toHexString()), 'mfa_enrolment', ctx);
  }

  async verifyMfa(mfaToken: string, code: string, ctx: AuditContext): Promise<SignInResult> {
    const user = await this.mfaSubject(mfaToken);
    if (!user.mfa?.enabled || !user.mfa.secretEnc)
      throw new DomainError('MFA_REQUIRED', 'Set up two-factor authentication first.');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new DomainError(
        'ACCOUNT_LOCKED',
        'Too many failed attempts. Try again later or reset your password.',
      );
    }
    const step = verifyTotp(this.crypto.decrypt(user.mfa.secretEnc), code);
    // A code may be used once: replaying a step that was already accepted fails (RFC 6238 §5.2).
    if (step === null || !(await this.users.claimTotpStep(user._id, step))) {
      await this.registerFailure(user, ctx);
      throw new DomainError('MFA_INVALID', 'That code is not valid. Wait for the next code and try again.');
    }
    return this.completeSignIn(user, 'password_mfa', ctx);
  }

  /* ------------------------------------------------------------------ sessions */

  async refresh(
    rawToken: string | undefined,
    ctx: AuditContext,
  ): Promise<{ accessToken: string; expiresIn: number; refreshToken: string }> {
    if (!rawToken) throw new DomainError('UNAUTHENTICATED', 'Session has ended. Please sign in again.');
    const { userId, refreshToken } = await this.sessions.rotate(rawToken, ctx);
    const user = await this.users.findById(userId.toHexString());
    if (!user || user.status !== 'ACTIVE') {
      await this.sessions.revokeAllForUser(userId, 'USER_INACTIVE');
      throw new DomainError('UNAUTHENTICATED', 'Session has ended. Please sign in again.');
    }
    return {
      accessToken: await this.sessions.issueAccessToken(user),
      expiresIn: this.sessions.accessTtlSeconds,
      refreshToken,
    };
  }

  async logout(rawToken: string | undefined, ctx: AuditContext): Promise<void> {
    if (!rawToken) return;
    const userId = await this.sessions.revokeByRawToken(rawToken, 'LOGOUT');
    if (userId) {
      await this.audit.record({
        actor: { userId: userId.toHexString() },
        action: 'auth.logout',
        entityType: 'User',
        entityId: userId.toHexString(),
        context: ctx,
      });
    }
  }

  /** Admin force-logout (FR-AUTH-06): ends refresh sessions and invalidates live access tokens. */
  async forceLogout(
    userId: string,
    actor: AuditActor,
    ctx: AuditContext,
  ): Promise<{ revokedSessions: number }> {
    const user = await this.users.getById(userId);
    const revokedSessions = await this.sessions.revokeAllForUser(user._id, 'ADMIN');
    await this.users.bumpPermVersion([user._id]);
    await this.audit.record({
      actor,
      action: 'auth.sessions_revoked',
      entityType: 'User',
      entityId: userId,
      after: { revokedSessions },
      context: ctx,
    });
    return { revokedSessions };
  }

  async me(principal: AuthUser): Promise<SessionUser> {
    const user = await this.users.getById(principal.id);
    return this.toSessionUser(user, principal);
  }

  /* ------------------------------------------------------------------ helpers */

  private assertActive(user: UserDoc): void {
    if (user.status !== 'ACTIVE') {
      throw new DomainError('ACCOUNT_SUSPENDED', 'This account is not active. Contact support for help.');
    }
  }

  private async completeSignIn(user: UserDoc, method: string, ctx: AuditContext): Promise<SignInResult> {
    await this.users.recordLoginSuccess(user._id);
    const [accessToken, refreshToken] = await Promise.all([
      this.sessions.issueAccessToken(user),
      this.sessions.createRefreshToken(user._id, ctx),
    ]);
    const access = await this.roles.accessFor(user._id);
    await this.audit.record({
      actor: { userId: user._id.toHexString(), userType: user.userType, roleCodes: access.roleCodes },
      action: 'auth.login',
      entityType: 'User',
      entityId: user._id.toHexString(),
      after: { method },
      context: ctx,
    });
    return {
      response: {
        status: 'AUTHENTICATED',
        accessToken,
        expiresIn: this.sessions.accessTtlSeconds,
        user: this.toSessionUser(user, access),
      },
      refreshToken,
    };
  }

  private toSessionUser(
    user: UserDoc,
    access: Pick<AuthUser, 'roleCodes' | 'permissions' | 'scopes'>,
  ): SessionUser {
    return {
      id: user._id.toHexString(),
      name: user.name,
      userType: user.userType,
      ...(user.mobile ? { mobile: user.mobile } : {}),
      ...(user.email ? { email: user.email } : {}),
      roleCodes: access.roleCodes,
      permissions: [...access.permissions].sort(),
      scopes: access.scopes,
      mfaEnabled: !!user.mfa?.enabled,
    };
  }
}
