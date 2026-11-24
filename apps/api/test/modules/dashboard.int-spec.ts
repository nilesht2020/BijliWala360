import { AuthModule } from '../../src/modules/auth/auth.module';
import { DashboardModule } from '../../src/modules/dashboard/dashboard.module';
import { UsersModule } from '../../src/modules/users/users.module';
import { adminSignIn, seedAdmin, signUpViaOtp } from '../setup/auth-helpers';
import { createTestApp, type TestApp } from '../setup/harness';

describe('Admin dashboard work queue', () => {
  let t: TestApp;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const day = (n: number) => new Date(Date.UTC(2026, 10, n));

  beforeAll(async () => {
    t = await createTestApp({ realAuth: true, imports: [UsersModule, AuthModule, DashboardModule] });
    const db = t.connection;
    await db
      .collection('provider_registrations')
      .insertMany([
        { verification: { status: 'PENDING', submittedAt: day(3) } },
        { verification: { status: 'PENDING', submittedAt: day(1) } },
        { verification: { status: 'APPROVED', submittedAt: day(2) } },
      ]);
    await db.collection('documents').insertMany([
      { status: 'UPLOADED', typeCode: 'PAN_CARD', updatedAt: day(4) },
      { status: 'UPLOADED', typeCode: 'PAYMENT_PROOF', updatedAt: day(4) }, // reviewed with the payment
      { status: 'VERIFIED', typeCode: 'PHOTO', updatedAt: day(4) },
    ]);
    await db.collection('registration_payments').insertMany([
      { mode: 'OFFLINE', status: 'PENDING_VERIFICATION', createdAt: day(5) },
      { mode: 'ONLINE', status: 'SUCCESS', createdAt: day(5) },
    ]);
    await db.collection('companies').insertOne({ status: 'PENDING_VERIFICATION', createdAt: day(6) });
    await db.collection('enquiries').insertMany([
      { status: 'NEW', createdAt: day(7) },
      { status: 'QUOTED', createdAt: day(7) },
    ]);
    await db.collection('quotations').insertMany([
      { status: 'SENT', isLatest: true, updatedAt: day(8) },
      { status: 'SENT', isLatest: false, updatedAt: day(8) }, // an older version
    ]);
  });

  afterAll(async () => {
    await t?.close();
  });

  const queue = async (token: string) => {
    const res = await t.http().get('/api/v1/admin/dashboard/work-queue').set(bearer(token)).expect(200);
    return Object.fromEntries(
      (res.body.data.items as Array<{ key: string; count: number; oldestAt?: string }>).map((i) => [
        i.key,
        i,
      ]),
    );
  };

  it('counts every queue for a super admin, with the oldest waiting item', async () => {
    const token = await adminSignIn(t, t.agent(), await seedAdmin(t, ['SUPER_ADMIN']));
    const q = await queue(token);
    expect(q.REGISTRATIONS_TO_VERIFY).toEqual({
      key: 'REGISTRATIONS_TO_VERIFY',
      count: 2,
      oldestAt: day(1).toISOString(),
    });
    expect(q.DOCUMENTS_TO_REVIEW?.count).toBe(1);
    expect(q.OFFLINE_PAYMENTS_TO_VERIFY?.count).toBe(1);
    expect(q.COMPANIES_TO_ACTIVATE?.count).toBe(1);
    expect(q.NEW_ENQUIRIES?.count).toBe(1);
    expect(q.QUOTATIONS_AWAITING_CLIENT?.count).toBe(1);
    expect(q.JOBS_TO_STAFF).toEqual({ key: 'JOBS_TO_STAFF', count: 0 });
    expect(Object.keys(q)).toHaveLength(11);
  });

  it('shows each admin only the queues their role can act on', async () => {
    const finance = await adminSignIn(t, t.agent(), await seedAdmin(t, ['FINANCE_ADMIN']));
    expect(Object.keys(await queue(finance))).toEqual(['OFFLINE_PAYMENTS_TO_VERIFY']);

    const verifier = await adminSignIn(t, t.agent(), await seedAdmin(t, ['VERIFICATION_OFFICER']));
    expect(Object.keys(await queue(verifier))).toEqual([
      'REGISTRATIONS_TO_VERIFY',
      'DOCUMENTS_TO_REVIEW',
      'WORKERS_TO_VERIFY',
      'IDENTITY_CONFLICTS',
    ]);
  });

  it('is closed to non-admin users', async () => {
    const pro = await signUpViaOtp(t, t.agent(), { userType: 'PROFESSIONAL', name: 'Ravi Kumar' });
    await t.http().get('/api/v1/admin/dashboard/work-queue').set(bearer(pro.accessToken)).expect(403);
    await t.http().get('/api/v1/admin/dashboard/work-queue').expect(401);
  });
});
