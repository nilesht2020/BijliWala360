import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model, Types } from 'mongoose';
import type { AuditContext } from '../../core/audit/audit.service';
import type { AccessTokenClaims } from '../../core/auth/auth.types';
import { AppConfig } from '../../core/config/app-config';
import { randomToken, sha256 } from '../../core/crypto/password';
import { DomainError } from '../../core/errors/domain-error';
import type { UserDoc } from '../users/schemas';
import { REFRESH_TOKEN_MODEL, type RefreshTokenDoc, type RevokeReason } from './schemas';

export type StepAudience = 'signup' | 'mfa';

export interface SignupStepClaims {
  mobile: string;
}

export interface MfaStepClaims {
  sub: string;
  pv: number;
}

const STEP_TTL_SECONDS: Record<StepAudience, number> = { signup: 15 * 60, mfa: 5 * 60 };

export interface RotationResult {
  userId: Types.ObjectId;
  refreshToken: string;
}

/**
 * Token issuance (FR-AUTH-05):
 *  - access JWT (aud=access, 15 min by default) carrying sub/typ/pv only;
 *  - short-lived step JWTs for multi-step sign-in (aud=signup|mfa), unusable as access tokens;
 *  - opaque refresh tokens, stored hashed, rotated on every use; presenting an already-rotated
 *    token revokes the whole family (token theft detection).
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    @InjectModel(REFRESH_TOKEN_MODEL) private readonly tokens: Model<RefreshTokenDoc>,
  ) {}

  get accessTtlSeconds(): number {
    return this.config.env.JWT_ACCESS_TTL_SECONDS;
  }

  get refreshTtlMs(): number {
    return this.config.env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  issueAccessToken(user: Pick<UserDoc, '_id' | 'userType' | 'permVersion'>): Promise<string> {
    const claims: AccessTokenClaims = {
      sub: user._id.toHexString(),
      typ: user.userType,
      pv: user.permVersion,
    };
    return this.jwt.signAsync(claims);
  }

  signStepToken(audience: 'signup', claims: SignupStepClaims): Promise<string>;
  signStepToken(audience: 'mfa', claims: MfaStepClaims): Promise<string>;
  signStepToken(audience: StepAudience, claims: object): Promise<string> {
    return this.jwt.signAsync({ ...claims }, { audience, expiresIn: STEP_TTL_SECONDS[audience] });
  }

  async verifyStepToken(audience: 'signup', token: string): Promise<SignupStepClaims>;
  async verifyStepToken(audience: 'mfa', token: string): Promise<MfaStepClaims>;
  async verifyStepToken(audience: StepAudience, token: string): Promise<SignupStepClaims | MfaStepClaims> {
    try {
      return await this.jwt.verifyAsync(token, { audience });
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'This sign-in step has expired. Please start again.');
    }
  }

  async createRefreshToken(
    userId: Types.ObjectId,
    ctx: AuditContext,
    familyId: string = randomUUID(),
  ): Promise<string> {
    const raw = randomToken(32);
    await this.tokens.create({
      userId,
      familyId,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + this.refreshTtlMs),
      userAgent: ctx.userAgent,
      ip: ctx.ip,
    });
    return raw;
  }

  /** Rotates a refresh token. Reuse of a rotated token revokes its family. */
  async rotate(raw: string, ctx: AuditContext): Promise<RotationResult> {
    const doc = await this.tokens
      .findOne({ tokenHash: sha256(raw) })
      .lean<RefreshTokenDoc>()
      .exec();
    if (!doc) throw new DomainError('UNAUTHENTICATED', 'Session has ended. Please sign in again.');

    if (doc.revokedAt) {
      if (doc.revokedReason === 'ROTATED') {
        await this.revokeFamily(doc.familyId, 'REUSE_DETECTED');
        throw new DomainError(
          'REFRESH_TOKEN_REUSED',
          'Session has ended for security reasons. Please sign in again.',
        );
      }
      throw new DomainError('UNAUTHENTICATED', 'Session has ended. Please sign in again.');
    }
    if (doc.expiresAt <= new Date())
      throw new DomainError('UNAUTHENTICATED', 'Session has expired. Please sign in again.');

    // Conditional revoke: of two concurrent refreshes with the same token only one wins.
    const res = await this.tokens.updateOne(
      { _id: doc._id, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: 'ROTATED' } },
    );
    if (res.modifiedCount !== 1) {
      await this.revokeFamily(doc.familyId, 'REUSE_DETECTED');
      throw new DomainError(
        'REFRESH_TOKEN_REUSED',
        'Session has ended for security reasons. Please sign in again.',
      );
    }
    const refreshToken = await this.createRefreshToken(doc.userId, ctx, doc.familyId);
    return { userId: doc.userId, refreshToken };
  }

  /** Revokes the family a raw token belongs to (logout). Unknown tokens are ignored. */
  async revokeByRawToken(raw: string, reason: RevokeReason): Promise<Types.ObjectId | null> {
    const doc = await this.tokens
      .findOne({ tokenHash: sha256(raw) })
      .lean<RefreshTokenDoc>()
      .exec();
    if (!doc) return null;
    await this.revokeFamily(doc.familyId, reason);
    return doc.userId;
  }

  async revokeAllForUser(userId: Types.ObjectId, reason: RevokeReason): Promise<number> {
    const res = await this.tokens.updateMany(
      { userId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
    return res.modifiedCount;
  }

  private async revokeFamily(familyId: string, reason: RevokeReason): Promise<void> {
    await this.tokens.updateMany(
      { familyId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
  }
}
