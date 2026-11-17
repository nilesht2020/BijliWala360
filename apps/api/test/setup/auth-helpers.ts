import type { NestExpressApplication } from '@nestjs/platform-express';
import type request from 'supertest';
import { REFRESH_COOKIE, type AuthStepResponse, type SelfSignupUserType } from '@skillconnect/contracts';
import {
  EMAIL_PROVIDER,
  SMS_PROVIDER,
  type ConsoleEmailProvider,
  type ConsoleSmsProvider,
} from '../../src/core/channels/channels';
import { TransactionRunner } from '../../src/core/database/transaction-runner';
import { hashPassword } from '../../src/core/crypto/password';
import { totp } from '../../src/modules/auth/domain/totp';
import { RolesService } from '../../src/modules/users/roles.service';
import { UsersService } from '../../src/modules/users/users.service';
import type { TestApp } from './harness';

type Agent = ReturnType<typeof request.agent>;

let mobileSeq = 0;
/** A fresh valid Indian mobile per call so per-number limits never collide across tests. */
export function nextMobile(): string {
  mobileSeq += 1;
  return `+9198${String(process.pid % 1000).padStart(3, '0')}${String(mobileSeq).padStart(5, '0')}`;
}

export function smsOutbox(app: NestExpressApplication): ConsoleSmsProvider {
  return app.get<ConsoleSmsProvider>(SMS_PROVIDER);
}

export function emailOutbox(app: NestExpressApplication): ConsoleEmailProvider {
  return app.get<ConsoleEmailProvider>(EMAIL_PROVIDER);
}

/** Reads the most recent OTP sent to a number from the console SMS adapter. */
export function lastOtpFor(app: NestExpressApplication, mobile: string): string {
  const msg = [...smsOutbox(app).sent]
    .reverse()
    .find((m) => m.to === mobile && /verification code/.test(m.body));
  const code = msg?.body.match(/^(\d{6})/)?.[1];
  if (!code) throw new Error(`No OTP sent to ${mobile}`);
  return code;
}

export function refreshCookieFrom(res: { headers: Record<string, unknown> }): string | undefined {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  return cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`))?.split(';')[0];
}

export async function requestOtp(agent: Agent, mobile: string): Promise<string> {
  const res = await agent.post('/api/v1/auth/otp/request').send({ mobile }).expect(200);
  return res.body.data.challengeId as string;
}

/** Full OTP sign-up for a new mobile number; returns the access token. */
export async function signUpViaOtp(
  t: TestApp,
  agent: Agent,
  opts: { mobile?: string; userType?: SelfSignupUserType; name?: string } = {},
): Promise<{ accessToken: string; mobile: string; userId: string }> {
  const mobile = opts.mobile ?? nextMobile();
  const challengeId = await requestOtp(agent, mobile);
  const verify = await agent
    .post('/api/v1/auth/otp/verify')
    .send({ challengeId, code: lastOtpFor(t.app, mobile) })
    .expect(200);
  const step = verify.body.data as AuthStepResponse;
  if (step.status !== 'SIGNUP_REQUIRED') throw new Error(`Expected SIGNUP_REQUIRED, got ${step.status}`);
  const res = await agent
    .post('/api/v1/auth/signup')
    .send({
      signupToken: step.signupToken,
      name: opts.name ?? 'Test User',
      userType: opts.userType ?? 'PROFESSIONAL',
      acceptTerms: true,
    })
    .expect(200);
  return { accessToken: res.body.data.accessToken, mobile, userId: res.body.data.user.id };
}

export interface SeededAdmin {
  userId: string;
  email: string;
  password: string;
  totpSecret?: string;
}

/** Creates an ADMIN user with a password and platform roles directly through the services. */
export async function seedAdmin(
  t: TestApp,
  roleCodes: string[],
  email = `admin${Date.now()}${Math.random().toString(16).slice(2, 6)}@test.local`,
): Promise<SeededAdmin> {
  const users = t.app.get(UsersService);
  const roles = t.app.get(RolesService);
  const password = 'Str0ng-Passw0rd!';
  const user = await t.app.get(TransactionRunner).run(async (session) => {
    const u = await users.createAdmin({ name: 'Seed Admin', email }, session);
    for (const roleCode of roleCodes) {
      await roles.grant(
        u._id.toHexString(),
        { roleCode, scope: { type: 'PLATFORM' } },
        { system: 'test' },
        undefined,
        session,
      );
    }
    return u;
  });
  await users.setPasswordHash(user._id, await hashPassword(password, { N: 2 ** 10, r: 8, p: 1 }));
  return { userId: user._id.toHexString(), email, password };
}

/**
 * Admin sign-in through the real endpoints: password -> (enrol TOTP on first login) -> TOTP.
 * `stepOffset` lets repeated logins use a fresh time step (codes are single-use).
 */
export async function adminSignIn(
  _t: TestApp,
  agent: Agent,
  admin: SeededAdmin,
  stepOffset = 0,
): Promise<string> {
  const login = await agent
    .post('/api/v1/auth/admin/login')
    .send({ email: admin.email, password: admin.password })
    .expect(200);
  const step = login.body.data as AuthStepResponse;
  const now = Date.now() + stepOffset * 30_000;
  if (step.status === 'MFA_ENROLLMENT_REQUIRED') {
    const enrol = await agent
      .post('/api/v1/auth/admin/mfa/enroll')
      .send({ mfaToken: step.mfaToken })
      .expect(200);
    admin.totpSecret = enrol.body.data.secret as string;
    const done = await agent
      .post('/api/v1/auth/admin/mfa/enroll/confirm')
      .send({ mfaToken: step.mfaToken, totp: totp(admin.totpSecret, now) })
      .expect(200);
    return done.body.data.accessToken as string;
  }
  if (step.status !== 'MFA_REQUIRED' || !admin.totpSecret) throw new Error(`Unexpected step ${step.status}`);
  const done = await agent
    .post('/api/v1/auth/admin/mfa/verify')
    .send({ mfaToken: step.mfaToken, totp: totp(admin.totpSecret, now) })
    .expect(200);
  return done.body.data.accessToken as string;
}
