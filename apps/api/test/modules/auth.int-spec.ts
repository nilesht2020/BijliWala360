import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { totp } from '../../src/modules/auth/domain/totp';
import { OTP_CHALLENGE_MODEL, type OtpChallengeDoc } from '../../src/modules/auth/schemas';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { PlatformModule } from '../../src/modules/platform/platform.module';
import { UsersModule } from '../../src/modules/users/users.module';
import { OUTBOX_MODEL, type OutboxDoc } from '../../src/core/database/core.schemas';
import {
  adminSignIn,
  emailOutbox,
  lastOtpFor,
  nextMobile,
  refreshCookieFrom,
  requestOtp,
  seedAdmin,
  signUpViaOtp,
} from '../setup/auth-helpers';
import { createTestApp, type TestApp } from '../setup/harness';

describe('Auth (FR-AUTH-01..09)', () => {
  let t: TestApp;
  let challenges: Model<OtpChallengeDoc>;

  beforeAll(async () => {
    t = await createTestApp({
      realAuth: true,
      imports: [UsersModule, AuthModule, NotificationsModule, PlatformModule],
    });
    challenges = t.app.get(getModelToken(OTP_CHALLENGE_MODEL));
  });

  beforeEach(async () => {
    await t.redis.flushall(); // reset rate-limit windows and caches between tests
  });

  afterAll(async () => {
    await t?.close();
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Moves challenges into the past. Uses the raw collection: Mongoose treats createdAt as immutable. */
  const ageChallenges = async (filter: Record<string, unknown>, ms: number) => {
    await t.connection
      .collection('otp_challenges')
      .updateMany(filter, { $set: { createdAt: new Date(Date.now() - ms) } });
  };

  describe('mobile OTP sign-up and sign-in', () => {
    it('signs up a new professional, sets the refresh cookie and grants the PROFESSIONAL role', async () => {
      const agent = t.agent();
      const mobile = nextMobile();
      const challengeId = await requestOtp(agent, mobile);
      const verify = await agent
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: lastOtpFor(t.app, mobile) })
        .expect(200);
      expect(verify.body.data.status).toBe('SIGNUP_REQUIRED');
      expect(refreshCookieFrom(verify)).toBeUndefined();

      const signup = await agent
        .post('/api/v1/auth/signup')
        .send({
          signupToken: verify.body.data.signupToken,
          name: 'Asha Kumar',
          userType: 'PROFESSIONAL',
          acceptTerms: true,
        })
        .expect(200);
      expect(signup.body.data).toMatchObject({
        status: 'AUTHENTICATED',
        user: { name: 'Asha Kumar', userType: 'PROFESSIONAL', roleCodes: ['PROFESSIONAL'] },
      });
      expect(signup.body.data.user.permissions).toContain('invitation.respond');
      const cookie = signup.headers['set-cookie'] as unknown as string[];
      expect(cookie.join(';')).toMatch(/sc_rt=.+HttpOnly.+SameSite=Strict/i);
      expect(cookie.join(';')).toContain('Path=/api/v1/auth');

      const me = await t.http().get('/api/v1/auth/me').set(bearer(signup.body.data.accessToken)).expect(200);
      expect(me.body.data).toMatchObject({ mobile, userType: 'PROFESSIONAL', mfaEnabled: false });

      const outbox = t.app.get<Model<OutboxDoc>>(getModelToken(OUTBOX_MODEL));
      const evt = await outbox
        .findOne({ type: 'notification.requested', 'payload.recipients.userId': signup.body.data.user.id })
        .lean();
      expect(evt?.payload).toMatchObject({ eventType: 'account.created', priority: 'NORMAL' });
    });

    it('signs in an existing user directly after OTP', async () => {
      const { mobile } = await signUpViaOtp(t, t.agent(), { userType: 'COMPANY' });
      await ageChallenges({ mobile }, 120_000); // past cooldown
      const agent = t.agent();
      const challengeId = await requestOtp(agent, mobile);
      const res = await agent
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: lastOtpFor(t.app, mobile) })
        .expect(200);
      expect(res.body.data).toMatchObject({
        status: 'AUTHENTICATED',
        user: { userType: 'COMPANY', roleCodes: [] },
      });
      expect(refreshCookieFrom(res)).toBeDefined();
    });

    it('limits wrong guesses and burns the challenge after the maximum', async () => {
      const mobile = nextMobile();
      const challengeId = await requestOtp(t.http(), mobile);
      const real = lastOtpFor(t.app, mobile);
      const wrong = real === '000000' ? '111111' : '000000';
      const first = await t
        .http()
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: wrong })
        .expect(422);
      expect(first.body.error).toMatchObject({
        code: 'OTP_INVALID',
        details: [{ field: 'code', attemptsRemaining: 4 }],
      });
      for (let i = 0; i < 4; i += 1)
        await t.http().post('/api/v1/auth/otp/verify').send({ challengeId, code: wrong });
      const after = await t
        .http()
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: real })
        .expect(422);
      expect(after.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    });

    it('never allows more than the maximum attempts under parallel guessing', async () => {
      const mobile = nextMobile();
      const challengeId = await requestOtp(t.http(), mobile);
      const real = lastOtpFor(t.app, mobile);
      const wrong = real === '999999' ? '888888' : '999999';
      await Promise.all(
        Array.from({ length: 12 }, () =>
          t.http().post('/api/v1/auth/otp/verify').send({ challengeId, code: wrong }),
        ),
      );
      const doc = await challenges.findById(challengeId).lean();
      expect(doc?.attempts).toBe(5);
    });

    it('enforces the resend cooldown and supersedes older codes', async () => {
      const mobile = nextMobile();
      const first = await requestOtp(t.http(), mobile);
      const firstCode = lastOtpFor(t.app, mobile);
      const cooldown = await t.http().post('/api/v1/auth/otp/request').send({ mobile }).expect(429);
      expect(cooldown.body.error.code).toBe('OTP_RESEND_COOLDOWN');

      await ageChallenges({ mobile }, 60_000);
      await requestOtp(t.http(), mobile);
      const old = await t
        .http()
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId: first, code: firstCode })
        .expect(422);
      expect(old.body.error.code).toBe('OTP_EXPIRED');
    });

    it('rejects expired codes and single-use codes', async () => {
      const mobile = nextMobile();
      const challengeId = await requestOtp(t.http(), mobile);
      const code = lastOtpFor(t.app, mobile);
      await challenges.updateOne({ _id: challengeId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      expect(
        (await t.http().post('/api/v1/auth/otp/verify').send({ challengeId, code }).expect(422)).body.error
          .code,
      ).toBe('OTP_EXPIRED');

      const m2 = nextMobile();
      const c2 = await requestOtp(t.http(), m2);
      const code2 = lastOtpFor(t.app, m2);
      await t.http().post('/api/v1/auth/otp/verify').send({ challengeId: c2, code: code2 }).expect(200);
      await t.http().post('/api/v1/auth/otp/verify').send({ challengeId: c2, code: code2 }).expect(422);
    });

    it('rate-limits OTP requests per mobile number', async () => {
      const mobile = nextMobile();
      for (let i = 0; i < 5; i += 1) {
        await ageChallenges({ mobile }, 3_600_000);
        await t.http().post('/api/v1/auth/otp/request').send({ mobile });
      }
      const res = await t.http().post('/api/v1/auth/otp/request').send({ mobile }).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });

    it('does not accept a sign-up step token as an access token', async () => {
      const mobile = nextMobile();
      const challengeId = await requestOtp(t.http(), mobile);
      const verify = await t
        .http()
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: lastOtpFor(t.app, mobile) })
        .expect(200);
      await t.http().get('/api/v1/auth/me').set(bearer(verify.body.data.signupToken)).expect(401);
    });

    it('rejects sign-up for a mobile that already has an account', async () => {
      const { mobile } = await signUpViaOtp(t, t.agent());
      const signupToken = await t.app
        .get((await import('../../src/modules/auth/session.service')).SessionService)
        .signStepToken('signup', { mobile });
      const res = await t
        .http()
        .post('/api/v1/auth/signup')
        .send({ signupToken, name: 'Dup', userType: 'VENDOR', acceptTerms: true })
        .expect(409);
      expect(res.body.error.code).toBe('DUPLICATE_ACCOUNT');
    });

    it('never lets an administrator sign in with OTP alone', async () => {
      const admin = await seedAdmin(t, ['OPS_ADMIN']);
      const mobile = nextMobile();
      await t.connection.collection('users').updateOne({ email: admin.email }, { $set: { mobile } });
      const challengeId = await requestOtp(t.http(), mobile);
      const res = await t
        .http()
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: lastOtpFor(t.app, mobile) })
        .expect(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('refresh tokens', () => {
    it('rotates on every refresh and revokes the family when an old token is replayed', async () => {
      const agent = t.agent();
      const signup = await signUpViaOtp(t, agent);
      void signup;
      const r1 = await agent.post('/api/v1/auth/refresh').expect(200);
      const oldCookie = refreshCookieFrom(r1);
      expect(r1.body.data.accessToken).toEqual(expect.any(String));
      const r2 = await agent.post('/api/v1/auth/refresh').expect(200);
      expect(refreshCookieFrom(r2)).not.toBe(oldCookie);

      // Replaying a rotated token (theft) kills the whole family, including the newest token.
      const replay = await t
        .http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', oldCookie as string)
        .expect(401);
      expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
      await agent.post('/api/v1/auth/refresh').expect(401);
    });

    it('logout ends the session and clears the cookie', async () => {
      const agent = t.agent();
      await signUpViaOtp(t, agent);
      const res = await agent.post('/api/v1/auth/logout').expect(200);
      expect((res.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/sc_rt=;/);
      await agent.post('/api/v1/auth/refresh').expect(401);
    });

    it('refuses to refresh without a cookie', async () => {
      const res = await t.http().post('/api/v1/auth/refresh').expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('admin password + TOTP', () => {
    it('requires TOTP enrolment on first login, then TOTP on every login', async () => {
      const admin = await seedAdmin(t, ['OPS_ADMIN']);
      const agent = t.agent();
      const token = await adminSignIn(t, agent, admin);
      const me = await t.http().get('/api/v1/auth/me').set(bearer(token)).expect(200);
      expect(me.body.data).toMatchObject({ userType: 'ADMIN', mfaEnabled: true, roleCodes: ['OPS_ADMIN'] });

      const login = await t
        .http()
        .post('/api/v1/auth/admin/login')
        .send({ email: admin.email, password: admin.password })
        .expect(200);
      expect(login.body.data.status).toBe('MFA_REQUIRED');
      expect(login.body.data.accessToken).toBeUndefined();
      // The MFA step token is not an access token.
      await t.http().get('/api/v1/auth/me').set(bearer(login.body.data.mfaToken)).expect(401);
    });

    it('rejects a replayed TOTP code', async () => {
      const admin = await seedAdmin(t, ['OPS_ADMIN']);
      await adminSignIn(t, t.agent(), admin); // enrols at the current step
      const login = await t
        .http()
        .post('/api/v1/auth/admin/login')
        .send({ email: admin.email, password: admin.password });
      const sameStep = totp(admin.totpSecret as string);
      const res = await t
        .http()
        .post('/api/v1/auth/admin/mfa/verify')
        .send({ mfaToken: login.body.data.mfaToken, totp: sameStep })
        .expect(422);
      expect(res.body.error.code).toBe('MFA_INVALID');
      await adminSignIn(t, t.agent(), admin, 1); // the next step works
    });

    it('locks the account after repeated failures and returns the same error for unknown emails', async () => {
      const admin = await seedAdmin(t, ['OPS_ADMIN']);
      const unknown = await t
        .http()
        .post('/api/v1/auth/admin/login')
        .send({ email: 'nobody@test.local', password: 'whatever-123' })
        .expect(401);
      const wrong = await t
        .http()
        .post('/api/v1/auth/admin/login')
        .send({ email: admin.email, password: 'wrong-password-1' })
        .expect(401);
      expect(unknown.body.error).toEqual(wrong.body.error);

      for (let i = 0; i < 3; i += 1)
        await t
          .http()
          .post('/api/v1/auth/admin/login')
          .send({ email: admin.email, password: 'wrong-password-1' });
      const locked = await t
        .http()
        .post('/api/v1/auth/admin/login')
        .send({ email: admin.email, password: 'wrong-password-1' })
        .expect(423);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
      await t
        .http()
        .post('/api/v1/auth/admin/login')
        .send({ email: admin.email, password: admin.password })
        .expect(423);
    });

    it('only admins can use the admin login, only company users the password login', async () => {
      const admin = await seedAdmin(t, ['OPS_ADMIN']);
      await t
        .http()
        .post('/api/v1/auth/password/login')
        .send({ email: admin.email, password: admin.password })
        .expect(401);
    });
  });

  describe('password reset and change', () => {
    it('emails a single-use link, resets the password and ends existing sessions', async () => {
      const admin = await seedAdmin(t, ['OPS_ADMIN']);
      const agent = t.agent();
      await adminSignIn(t, agent, admin);

      await t.http().post('/api/v1/auth/password/forgot').send({ email: admin.email }).expect(202);
      await t.http().post('/api/v1/auth/password/forgot').send({ email: 'ghost@test.local' }).expect(202);
      const mail = [...emailOutbox(t.app).sent].reverse().find((m) => m.to === admin.email);
      const token = decodeURIComponent(/token=([^"&]+)/.exec(mail?.html ?? '')?.[1] ?? '');
      expect(mail?.html).toContain('http://web.test/reset-password?token=');

      await t.http().post('/api/v1/auth/password/reset').send({ token, newPassword: 'weak' }).expect(400);
      await t
        .http()
        .post('/api/v1/auth/password/reset')
        .send({ token, newPassword: 'N3w-Strong-Password' })
        .expect(200);
      await t
        .http()
        .post('/api/v1/auth/password/reset')
        .send({ token, newPassword: 'An0ther-Strong-Pass' })
        .expect(401);

      await agent.post('/api/v1/auth/refresh').expect(401); // old session ended
      await t
        .http()
        .post('/api/v1/auth/admin/login')
        .send({ email: admin.email, password: admin.password })
        .expect(401);
      admin.password = 'N3w-Strong-Password';
      await adminSignIn(t, t.agent(), admin, 1);
    });

    it('lets a company user set a password and then sign in with it', async () => {
      const agent = t.agent();
      const { accessToken } = await signUpViaOtp(t, agent, { userType: 'COMPANY' });
      const email = `buyer${Date.now()}@test.local`;
      await t.connection
        .collection('users')
        .updateOne(
          { mobile: { $exists: true }, userType: 'COMPANY', email: { $exists: false } },
          { $set: { email } },
        );
      const changed = await agent
        .put('/api/v1/auth/password')
        .set(bearer(accessToken))
        .send({ newPassword: 'C0mpany-Password!' })
        .expect(200);
      expect(changed.body.data.status).toBe('AUTHENTICATED');
      await t.http().get('/api/v1/auth/me').set(bearer(accessToken)).expect(401); // old token invalidated
      const login = await t
        .http()
        .post('/api/v1/auth/password/login')
        .send({ email, password: 'C0mpany-Password!' })
        .expect(200);
      expect(login.body.data.user.userType).toBe('COMPANY');
    });
  });

  describe('suspension and force logout', () => {
    it('cuts off a suspended user immediately and blocks re-login and refresh', async () => {
      const superAdmin = await seedAdmin(t, ['SUPER_ADMIN']);
      const adminToken = await adminSignIn(t, t.agent(), superAdmin);
      const agent = t.agent();
      const user = await signUpViaOtp(t, agent);
      await t.http().get('/api/v1/auth/me').set(bearer(user.accessToken)).expect(200);

      await t
        .http()
        .post(`/api/v1/admin/users/${user.userId}/suspend`)
        .set(bearer(adminToken))
        .send({ reason: 'Fraud review' })
        .expect(200);
      await t.http().get('/api/v1/auth/me').set(bearer(user.accessToken)).expect(401);
      await agent.post('/api/v1/auth/refresh').expect(401);

      await ageChallenges({ mobile: user.mobile }, 120_000);
      const challengeId = await requestOtp(t.http(), user.mobile);
      const res = await t
        .http()
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: lastOtpFor(t.app, user.mobile) })
        .expect(403);
      expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('force logout revokes refresh sessions and live access tokens', async () => {
      const superAdmin = await seedAdmin(t, ['SUPER_ADMIN']);
      const adminToken = await adminSignIn(t, t.agent(), superAdmin);
      const agent = t.agent();
      const user = await signUpViaOtp(t, agent);
      const res = await t
        .http()
        .post(`/api/v1/admin/users/${user.userId}/sessions/revoke`)
        .set(bearer(adminToken))
        .expect(200);
      expect(res.body.data.revokedSessions).toBe(1);
      await t.http().get('/api/v1/auth/me').set(bearer(user.accessToken)).expect(401);
      await agent.post('/api/v1/auth/refresh').expect(401);
    });
  });

  describe('audit trail', () => {
    it('records login, failed login and OTP events without secrets', async () => {
      const admin = await seedAdmin(t, ['OPS_ADMIN']);
      await t
        .http()
        .post('/api/v1/auth/admin/login')
        .send({ email: admin.email, password: 'bad-password-0' });
      await adminSignIn(t, t.agent(), admin);
      const logs = await t.connection.collection('audit_logs').find({ entityId: admin.userId }).toArray();
      const actions = logs.map((l) => l.action);
      expect(actions).toEqual(
        expect.arrayContaining(['auth.login_failed', 'auth.mfa_enrolled', 'auth.login']),
      );
      expect(JSON.stringify(logs)).not.toContain(admin.password);
    });
  });
});
