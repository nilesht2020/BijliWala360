import { SYSTEM_ROLES } from '@skillconnect/contracts';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { PlatformModule } from '../../src/modules/platform/platform.module';
import { UsersModule } from '../../src/modules/users/users.module';
import { adminSignIn, emailOutbox, seedAdmin, signUpViaOtp, type SeededAdmin } from '../setup/auth-helpers';
import { createTestApp, type TestApp } from '../setup/harness';

describe('Users & RBAC (FR-USR-01..06)', () => {
  let t: TestApp;
  let superAdmin: SeededAdmin;
  let superToken: string;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await createTestApp({
      realAuth: true,
      imports: [UsersModule, AuthModule, NotificationsModule, PlatformModule],
    });
    superAdmin = await seedAdmin(t, ['SUPER_ADMIN']);
    superToken = await adminSignIn(t, t.agent(), superAdmin);
  });

  beforeEach(async () => {
    await t.redis.flushall();
  });

  afterAll(async () => {
    await t?.close();
  });

  it('seeds every system role exactly once', async () => {
    const res = await t.http().get('/api/v1/admin/roles').set(bearer(superToken)).expect(200);
    const codes = (res.body.data as Array<{ code: string; isSystem: boolean }>)
      .filter((r) => r.isSystem)
      .map((r) => r.code);
    expect(codes.sort()).toEqual(SYSTEM_ROLES.map((r) => r.code).sort());
  });

  it('denies admin endpoints to users without the permission', async () => {
    const provider = await signUpViaOtp(t, t.agent());
    await t.http().get('/api/v1/admin/users').set(bearer(provider.accessToken)).expect(403);
    await t.http().get('/api/v1/admin/roles').set(bearer(provider.accessToken)).expect(403);
    await t.http().get('/api/v1/admin/users').expect(401);
  });

  it('creates an admin with roles and emails a password-setup link', async () => {
    const email = `ops${Date.now()}@test.local`;
    const res = await t
      .http()
      .post('/api/v1/admin/users')
      .set(bearer(superToken))
      .send({ name: 'Ops Person', email, roleCodes: ['OPS_ADMIN', 'ALLOCATION_APPROVER'] })
      .expect(201);
    expect(res.body.data).toMatchObject({
      userType: 'ADMIN',
      email,
      roleCodes: ['ALLOCATION_APPROVER', 'OPS_ADMIN'],
      mfaEnabled: false,
    });
    expect(res.body.data.assignments).toHaveLength(2);
    const mail = emailOutbox(t.app).sent.find((m) => m.to === email);
    expect(mail?.subject).toBe('Set up your SkillConnect admin account');

    const dup = await t
      .http()
      .post('/api/v1/admin/users')
      .set(bearer(superToken))
      .send({ name: 'Dup', email, roleCodes: ['OPS_ADMIN'] })
      .expect(409);
    expect(dup.body.error.code).toBe('DUPLICATE_ACCOUNT');

    const bad = await t
      .http()
      .post('/api/v1/admin/users')
      .set(bearer(superToken))
      .send({ name: 'Xavier', email: `x${email}`, roleCodes: ['COMPANY_ADMIN'] })
      .expect(422);
    expect(bad.body.error.code).toBe('ROLE_SCOPE_MISMATCH');
  });

  it('applies role permission changes on the next request (after token refresh)', async () => {
    const ops = await seedAdmin(t, ['OPS_ADMIN']);
    const agent = t.agent();
    const token = await adminSignIn(t, agent, ops);
    await t.http().get('/api/v1/admin/audit-logs').set(bearer(token)).expect(403);

    const roles = await t.http().get('/api/v1/admin/roles').set(bearer(superToken));
    const opsRole = (
      roles.body.data as Array<{ id: string; code: string; permissions: string[]; version: number }>
    ).find((r) => r.code === 'OPS_ADMIN');
    if (!opsRole) throw new Error('OPS_ADMIN missing');
    await t
      .http()
      .patch(`/api/v1/admin/roles/${opsRole.id}`)
      .set(bearer(superToken))
      .set('If-Match', String(opsRole.version))
      .send({ permissions: [...opsRole.permissions, 'audit.read'] })
      .expect(200);

    // The change bumps permVersion of every holder: the old token is rejected...
    await t.http().get('/api/v1/admin/audit-logs').set(bearer(token)).expect(401);
    // ...and a refreshed token carries the new permission.
    const refreshed = await agent.post('/api/v1/auth/refresh').expect(200);
    await t.http().get('/api/v1/admin/audit-logs').set(bearer(refreshed.body.data.accessToken)).expect(200);

    const stale = await t
      .http()
      .patch(`/api/v1/admin/roles/${opsRole.id}`)
      .set(bearer(superToken))
      .set('If-Match', String(opsRole.version))
      .send({ name: 'Ops' })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_MISMATCH');
  });

  it('validates role scope and user type on grant, and grants are idempotent', async () => {
    const provider = await signUpViaOtp(t, t.agent());
    const wrongType = await t
      .http()
      .post(`/api/v1/admin/users/${provider.userId}/role-assignments`)
      .set(bearer(superToken))
      .send({ roleCode: 'OPS_ADMIN', scope: { type: 'PLATFORM' } })
      .expect(422);
    expect(wrongType.body.error.code).toBe('ROLE_SCOPE_MISMATCH');

    const wrongScope = await t
      .http()
      .post(`/api/v1/admin/users/${provider.userId}/role-assignments`)
      .set(bearer(superToken))
      .send({ roleCode: 'COMPANY_ADMIN', scope: { type: 'PLATFORM' } })
      .expect(422);
    expect(wrongScope.body.error.code).toBe('ROLE_SCOPE_MISMATCH');

    const admin = await seedAdmin(t, ['SUPPORT_AGENT']);
    const a1 = await t
      .http()
      .post(`/api/v1/admin/users/${admin.userId}/role-assignments`)
      .set(bearer(superToken))
      .send({ roleCode: 'FINANCE_ADMIN', scope: { type: 'PLATFORM' } })
      .expect(201);
    const a2 = await t
      .http()
      .post(`/api/v1/admin/users/${admin.userId}/role-assignments`)
      .set(bearer(superToken))
      .send({ roleCode: 'FINANCE_ADMIN', scope: { type: 'PLATFORM' } })
      .expect(201);
    expect(a2.body.data.id).toBe(a1.body.data.id);
  });

  it('protects the last Super Admin and prevents self-suspension', async () => {
    const detail = await t
      .http()
      .get(`/api/v1/admin/users/${superAdmin.userId}`)
      .set(bearer(superToken))
      .expect(200);
    const assignment = (detail.body.data.assignments as Array<{ id: string; roleCode: string }>).find(
      (a) => a.roleCode === 'SUPER_ADMIN',
    );
    const revoke = await t
      .http()
      .delete(`/api/v1/admin/users/${superAdmin.userId}/role-assignments/${assignment?.id}`)
      .set(bearer(superToken))
      .expect(422);
    expect(revoke.body.error.code).toBe('LAST_SUPER_ADMIN');
    const suspend = await t
      .http()
      .post(`/api/v1/admin/users/${superAdmin.userId}/suspend`)
      .set(bearer(superToken))
      .send({ reason: 'test' })
      .expect(422);
    expect(suspend.body.error.code).toBe('LAST_SUPER_ADMIN');
  });

  it('protects system roles and roles in use', async () => {
    const roles = await t.http().get('/api/v1/admin/roles').set(bearer(superToken));
    const system = (roles.body.data as Array<{ id: string; isSystem: boolean }>).find((r) => r.isSystem);
    expect(
      (await t.http().delete(`/api/v1/admin/roles/${system?.id}`).set(bearer(superToken)).expect(422)).body
        .error.code,
    ).toBe('SYSTEM_ROLE_PROTECTED');

    const created = await t
      .http()
      .post('/api/v1/admin/roles')
      .set(bearer(superToken))
      .send({ code: 'REGIONAL_OPS', name: 'Regional ops', scopeType: 'PLATFORM', permissions: ['job.read'] })
      .expect(201);
    const admin = await seedAdmin(t, ['SUPPORT_AGENT']);
    const grant = await t
      .http()
      .post(`/api/v1/admin/users/${admin.userId}/role-assignments`)
      .set(bearer(superToken))
      .send({ roleCode: 'REGIONAL_OPS', scope: { type: 'PLATFORM' } })
      .expect(201);
    expect(
      (
        await t
          .http()
          .delete(`/api/v1/admin/roles/${created.body.data.id}`)
          .set(bearer(superToken))
          .expect(422)
      ).body.error.code,
    ).toBe('ROLE_IN_USE');
    await t
      .http()
      .delete(`/api/v1/admin/users/${admin.userId}/role-assignments/${grant.body.data.id}`)
      .set(bearer(superToken))
      .expect(200);
    await t.http().delete(`/api/v1/admin/roles/${created.body.data.id}`).set(bearer(superToken)).expect(200);

    await t
      .http()
      .post('/api/v1/admin/roles')
      .set(bearer(superToken))
      .send({ code: 'bad code', name: 'x', scopeType: 'PLATFORM', permissions: [] })
      .expect(400);
    await t
      .http()
      .post('/api/v1/admin/roles')
      .set(bearer(superToken))
      .send({ code: 'NEW_ROLE', name: 'x', scopeType: 'PLATFORM', permissions: ['not.real'] })
      .expect(400);
  });

  it('lists and filters users', async () => {
    const vendor = await signUpViaOtp(t, t.agent(), { userType: 'VENDOR', name: 'Zed Vendors' });
    const byType = await t
      .http()
      .get('/api/v1/admin/users?userType=VENDOR&pageSize=100')
      .set(bearer(superToken))
      .expect(200);
    expect((byType.body.data as Array<{ id: string }>).map((u) => u.id)).toContain(vendor.userId);
    expect(byType.body.meta).toMatchObject({ page: 1, pageSize: 100 });

    const byName = await t.http().get('/api/v1/admin/users?q=zed%20vend').set(bearer(superToken)).expect(200);
    expect(byName.body.data).toHaveLength(1);

    const byRole = await t
      .http()
      .get('/api/v1/admin/users?roleCode=SUPER_ADMIN')
      .set(bearer(superToken))
      .expect(200);
    expect((byRole.body.data as Array<{ id: string }>).map((u) => u.id)).toContain(superAdmin.userId);

    await t.http().get('/api/v1/admin/users?q[$ne]=x').set(bearer(superToken)).expect(400);
  });

  it('lets users rename themselves and admins reset MFA', async () => {
    const provider = await signUpViaOtp(t, t.agent());
    const me = await t
      .http()
      .patch('/api/v1/me')
      .set(bearer(provider.accessToken))
      .send({ name: 'New Name' })
      .expect(200);
    expect(me.body.data.name).toBe('New Name');

    const admin = await seedAdmin(t, ['OPS_ADMIN']);
    await adminSignIn(t, t.agent(), admin);
    const reset = await t
      .http()
      .post(`/api/v1/admin/users/${admin.userId}/mfa/reset`)
      .set(bearer(superToken))
      .expect(200);
    expect(reset.body.data.mfaEnabled).toBe(false);
    const login = await t
      .http()
      .post('/api/v1/auth/admin/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    expect(login.body.data.status).toBe('MFA_ENROLLMENT_REQUIRED');
  });
});
