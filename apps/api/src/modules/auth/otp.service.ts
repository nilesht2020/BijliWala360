import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { timingSafeEqual } from 'node:crypto';
import type { OtpChallengeResponse } from '@skillconnect/contracts';
import { BusinessConfigService } from '../../core/business-config/business-config.service';
import { AppConfig } from '../../core/config/app-config';
import { SMS_PROVIDER, type SmsProvider } from '../../core/channels/channels';
import { FieldCrypto } from '../../core/crypto/field-crypto';
import { DomainError } from '../../core/errors/domain-error';
import { generateNumericOtp } from './domain/totp';
import { OTP_CHALLENGE_MODEL, type OtpChallengeDoc } from './schemas';

const INVALID_CHALLENGE = 'This code has expired. Request a new one.';

/**
 * Mobile OTP issuance and verification (FR-AUTH-04). Codes are random, stored only as peppered
 * HMACs, single-use, time-limited and attempt-limited (attempts are counted atomically so parallel
 * guesses cannot exceed the limit). Requesting a new code supersedes older ones.
 */
@Injectable()
export class OtpService {
  constructor(
    @InjectModel(OTP_CHALLENGE_MODEL) private readonly challenges: Model<OtpChallengeDoc>,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly crypto: FieldCrypto,
    private readonly config: BusinessConfigService,
    private readonly app: AppConfig,
  ) {}

  /** Fixed development code (DEV_FIXED_OTP); the env validation refuses it in production. */
  private get fixedCode(): string | undefined {
    return this.app.env.NODE_ENV === 'production' ? undefined : this.app.env.DEV_FIXED_OTP;
  }

  private hashCode(mobile: string, code: string): string {
    return this.crypto.hash(`${mobile}:${code}`, 'OTP');
  }

  async request(mobile: string, ip?: string): Promise<OtpChallengeResponse> {
    const [ttl, maxAttempts, cooldown, maxSends, windowMin] = await Promise.all([
      this.config.get('otp.ttlSeconds'),
      this.config.get('otp.maxAttempts'),
      this.config.get('otp.resendCooldownSeconds'),
      this.config.get('otp.maxSendsPerWindow'),
      this.config.get('otp.sendWindowMinutes'),
    ]);
    const now = Date.now();

    const latest = await this.challenges
      .findOne({ mobile })
      .sort({ createdAt: -1 })
      .lean<OtpChallengeDoc>()
      .exec();
    if (latest && now - latest.createdAt.getTime() < cooldown * 1000) {
      const retryAfter = Math.ceil((latest.createdAt.getTime() + cooldown * 1000 - now) / 1000);
      throw new DomainError(
        'OTP_RESEND_COOLDOWN',
        `Please wait ${retryAfter} seconds before requesting another code.`,
        [{ retryAfterSec: retryAfter }],
      );
    }
    const recent = await this.challenges.countDocuments({
      mobile,
      createdAt: { $gt: new Date(now - windowMin * 60_000) },
    });
    if (recent >= maxSends) {
      throw new DomainError('OTP_SEND_LIMIT', `Too many codes requested. Try again in ${windowMin} minutes.`);
    }

    const code = this.fixedCode ?? generateNumericOtp();
    await this.challenges.updateMany(
      { mobile, consumedAt: { $exists: false }, supersededAt: { $exists: false } },
      { $set: { supersededAt: new Date(now) } },
    );
    const challenge = await this.challenges.create({
      _id: new Types.ObjectId(),
      mobile,
      purpose: 'LOGIN',
      codeHash: this.hashCode(mobile, code),
      attempts: 0,
      maxAttempts,
      expiresAt: new Date(now + ttl * 1000),
      ip,
    });

    try {
      await this.sms.send({
        to: mobile,
        body: `${code} is your SkillConnect verification code. It expires in ${Math.round(ttl / 60)} minutes. Do not share it with anyone.`,
      });
    } catch (err) {
      await this.challenges.deleteOne({ _id: challenge._id });
      throw err;
    }

    return {
      challengeId: challenge._id.toHexString(),
      expiresInSec: ttl,
      resendAfterSec: cooldown,
      ...(this.fixedCode ? { devCode: this.fixedCode } : {}),
    };
  }

  /** Returns the verified mobile number; consumes the challenge. */
  async verify(challengeId: string, code: string): Promise<string> {
    if (!Types.ObjectId.isValid(challengeId)) throw new DomainError('OTP_EXPIRED', INVALID_CHALLENGE);
    const now = new Date();
    const live = {
      _id: new Types.ObjectId(challengeId),
      consumedAt: { $exists: false },
      supersededAt: { $exists: false },
    };

    const challenge = await this.challenges
      .findOneAndUpdate(
        { ...live, expiresAt: { $gt: now }, $expr: { $lt: ['$attempts', '$maxAttempts'] } },
        { $inc: { attempts: 1 } },
        { new: true },
      )
      .lean<OtpChallengeDoc>()
      .exec();

    if (!challenge) {
      const existing = await this.challenges.findOne(live).lean<OtpChallengeDoc>().exec();
      if (existing && existing.expiresAt > now && existing.attempts >= existing.maxAttempts) {
        throw new DomainError('OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Request a new code.');
      }
      throw new DomainError('OTP_EXPIRED', INVALID_CHALLENGE);
    }

    const expected = Buffer.from(challenge.codeHash);
    const actual = Buffer.from(this.hashCode(challenge.mobile, code));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      const remaining = challenge.maxAttempts - challenge.attempts;
      if (remaining <= 0)
        throw new DomainError('OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Request a new code.');
      throw new DomainError('OTP_INVALID', 'The code is incorrect.', [
        { field: 'code', attemptsRemaining: remaining },
      ]);
    }

    const consumed = await this.challenges.updateOne({ ...live }, { $set: { consumedAt: now } });
    if (consumed.modifiedCount !== 1) throw new DomainError('OTP_EXPIRED', INVALID_CHALLENGE);
    return challenge.mobile;
  }
}
