import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { OUTBOX_MODEL, type OutboxDoc } from '../../src/core/database/core.schemas';
import { FakePaymentGateway, PaymentGateway } from '../../src/core/finance/payment-gateway';
import { DomainEventBus } from '../../src/core/outbox/event-bus';
import { OutboxRelay, type EventPublisher } from '../../src/core/outbox/outbox.relay';
import type { PublishedEvent } from '../../src/core/outbox/outbox.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { CatalogModule } from '../../src/modules/catalog/catalog.module';
import { DocumentsModule } from '../../src/modules/documents/documents.module';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { PersonsModule } from '../../src/modules/persons/persons.module';
import { PlansModule } from '../../src/modules/plans/plans.module';
import { PlatformModule } from '../../src/modules/platform/platform.module';
import { ProfessionalsModule } from '../../src/modules/professionals/professionals.module';
import { RegistrationsModule } from '../../src/modules/registrations/registrations.module';
import { UsersModule } from '../../src/modules/users/users.module';
import { VendorsModule } from '../../src/modules/vendors/vendors.module';
import { adminSignIn, seedAdmin, signUpViaOtp } from '../setup/auth-helpers';
import { createTestApp, type TestApp } from '../setup/harness';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 1),
]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0x20), Buffer.from('\n%%EOF')]);
const EICAR = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
]);

describe('Phase 3: catalogue, documents, provider onboarding and registration payments', () => {
  let t: TestApp;
  let superToken: string;
  let financeToken: string;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const pump = async () => {
    const bus = t.app.get(DomainEventBus);
    const publisher: EventPublisher = { publish: (e: PublishedEvent) => bus.dispatch(e) };
    await new OutboxRelay(t.app.get<Model<OutboxDoc>>(getModelToken(OUTBOX_MODEL)), publisher).tick();
  };

  /** intent -> PUT to the signed URL -> complete, exactly as the browser does. */
  const upload = async (
    token: string,
    owner: { type: string; id: string },
    typeCode: string,
    file: Buffer,
    mime: string,
    extra: object = {},
  ) => {
    const intent = await t
      .http()
      .post('/api/v1/documents/upload-intent')
      .set(bearer(token))
      .send({
        typeCode,
        owner,
        fileName: `${typeCode.toLowerCase()}.${mime.split('/')[1]}`,
        mime,
        sizeBytes: file.length,
        ...extra,
      })
      .expect(201);
    await t.http().put(intent.body.data.uploadUrl).set('Content-Type', mime).send(file).expect(200);
    const done = await t
      .http()
      .post(`/api/v1/documents/${intent.body.data.documentId}/complete`)
      .set(bearer(token))
      .expect(200);
    return done.body.data as { id: string; status: string };
  };

  let skillId: string;

  beforeAll(async () => {
    t = await createTestApp({
      realAuth: true,
      imports: [
        UsersModule,
        AuthModule,
        NotificationsModule,
        PlatformModule,
        CatalogModule,
        DocumentsModule,
        PlansModule,
        PersonsModule,
        ProfessionalsModule,
        VendorsModule,
        RegistrationsModule,
      ],
    });
    superToken = await adminSignIn(t, t.agent(), await seedAdmin(t, ['SUPER_ADMIN']));
    financeToken = await adminSignIn(t, t.agent(), await seedAdmin(t, ['FINANCE_ADMIN', 'FINANCE_APPROVER']));
    const cat = await t
      .http()
      .post('/api/v1/admin/categories')
      .set(bearer(superToken))
      .send({ name: 'Electrical' })
      .expect(201);
    const skill = await t
      .http()
      .post('/api/v1/admin/skills')
      .set(bearer(superToken))
      .send({ code: 'ELECTRICIAN', name: 'Electrician', categoryIds: [cat.body.data.id] })
      .expect(201);
    skillId = skill.body.data.id;
    await t
      .http()
      .post('/api/v1/admin/registration-plans')
      .set(bearer(superToken))
      .send({
        code: 'PRO_TEST',
        name: 'Pro',
        providerType: 'PROFESSIONAL',
        feePaise: 100_000,
        gstRateBp: 1800,
        sacCode: '998519',
        mandatoryDocTypeCodes: ['PHOTO', 'PAN_CARD'],
        refundPolicy: { onRejection: 'FULL' },
      })
      .expect(201);
    await t
      .http()
      .post('/api/v1/admin/registration-plans')
      .set(bearer(superToken))
      .send({
        code: 'VENDOR_TINY',
        name: 'Tiny vendor',
        providerType: 'VENDOR',
        feePaise: 200_000,
        gstRateBp: 1800,
        sacCode: '998519',
        maxWorkers: 2,
        mandatoryDocTypeCodes: [],
        refundPolicy: { onRejection: 'PARTIAL', partialPct: 50 },
      })
      .expect(201);
  });

  beforeEach(async () => {
    await t.redis.flushall();
  });

  afterAll(async () => {
    await t?.close();
  });

  /** A professional with a complete profile and both required documents uploaded. */
  async function readyProfessional(idNumber = 'ABCDE1234F') {
    const user = await signUpViaOtp(t, t.agent(), { userType: 'PROFESSIONAL', name: 'Ravi Kumar' });
    const created = await t.http().post('/api/v1/professionals/me').set(bearer(user.accessToken)).expect(201);
    const proId = created.body.data.id as string;
    await t
      .http()
      .patch('/api/v1/professionals/me')
      .set(bearer(user.accessToken))
      .send({
        dob: '1990-05-01',
        address: { line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
        serviceLocation: { lat: 18.52, lng: 73.85 },
        radiusKm: 20,
        languages: ['Hindi', 'Marathi'],
        experienceYears: 6,
        identity: { idType: 'PAN', idNumber },
      })
      .expect(200);
    await t
      .http()
      .put('/api/v1/professionals/me/skills')
      .set(bearer(user.accessToken))
      .send({ skills: [{ skillId, proficiency: 'EXPERT', years: 6 }] })
      .expect(200);
    const docs = [
      await upload(user.accessToken, { type: 'PROFESSIONAL', id: proId }, 'PHOTO', PNG, 'image/png'),
      await upload(
        user.accessToken,
        { type: 'PROFESSIONAL', id: proId },
        'PAN_CARD',
        PDF,
        'application/pdf',
        { number: idNumber },
      ),
    ];
    await t
      .http()
      .put('/api/v1/registrations/me/plan')
      .set(bearer(user.accessToken))
      .send({ planCode: 'PRO_TEST' })
      .expect(200);
    return { ...user, proId, docIds: docs.map((d) => d.id) };
  }

  async function payOnline(token: string) {
    const order = await t
      .http()
      .post('/api/v1/registrations/me/payments/online')
      .set(bearer(token))
      .set('Idempotency-Key', `pay-${Date.now()}-${Math.random().toString(16).slice(2)}`)
      .expect(201);
    expect(order.body.data).toMatchObject({ mode: 'fake', razorpay: { amount: 118_000, currency: 'INR' } });
    const checkout = await t
      .http()
      .post('/api/v1/dev/payments/simulate')
      .set(bearer(token))
      .send({ orderId: order.body.data.razorpay.orderId, outcome: 'success' })
      .expect(200);
    await t
      .http()
      .post(`/api/v1/registrations/me/payments/${order.body.data.paymentId}/verify`)
      .set(bearer(token))
      .send(checkout.body.data)
      .expect(200);
    await pump(); // webhook -> success
    return order.body.data.paymentId as string;
  }

  describe('catalogue', () => {
    it('serves the public tree and enforces the 3-level limit', async () => {
      const l1 = await t
        .http()
        .post('/api/v1/admin/categories')
        .set(bearer(superToken))
        .send({ name: 'Facilities' })
        .expect(201);
      const l2 = await t
        .http()
        .post('/api/v1/admin/categories')
        .set(bearer(superToken))
        .send({ name: 'Cleaning', parentId: l1.body.data.id })
        .expect(201);
      const l3 = await t
        .http()
        .post('/api/v1/admin/categories')
        .set(bearer(superToken))
        .send({ name: 'Deep cleaning', parentId: l2.body.data.id })
        .expect(201);
      expect(l3.body.data).toMatchObject({ level: 3, slug: 'deep-cleaning' });
      const tooDeep = await t
        .http()
        .post('/api/v1/admin/categories')
        .set(bearer(superToken))
        .send({ name: 'Too deep', parentId: l3.body.data.id })
        .expect(422);
      expect(tooDeep.body.error.code).toBe('CATEGORY_DEPTH_EXCEEDED');

      await t
        .http()
        .patch(`/api/v1/admin/categories/${l2.body.data.id}`)
        .set(bearer(superToken))
        .send({ isActive: false })
        .expect(200);
      const tree = await t.http().get('/api/v1/public/categories?tree=true').expect(200);
      const facilities = (tree.body.data as Array<{ slug: string; children: unknown[] }>).find(
        (c) => c.slug === 'facilities',
      );
      expect(facilities?.children).toEqual([]); // inactive branch hidden

      const detail = await t.http().get('/api/v1/public/categories/electrical').expect(200);
      expect(detail.body.data.skills.map((s: { code: string }) => s.code)).toEqual(['ELECTRICIAN']);
    });
  });

  describe('document uploads', () => {
    it('rejects files whose bytes do not match the declared type, and malware', async () => {
      const user = await signUpViaOtp(t, t.agent(), { userType: 'PROFESSIONAL' });
      const proId = (
        await t.http().post('/api/v1/professionals/me').set(bearer(user.accessToken)).expect(201)
      ).body.data.id;
      const spoofed = await upload(
        user.accessToken,
        { type: 'PROFESSIONAL', id: proId },
        'PAN_CARD',
        PNG,
        'application/pdf',
        { number: 'ABCDE1234F' },
      );
      expect(spoofed.status).toBe('REJECTED_TYPE');
      const infected = await upload(
        user.accessToken,
        { type: 'PROFESSIONAL', id: proId },
        'SKILL_CERT',
        EICAR,
        'application/pdf',
        { expiresOn: '2030-01-01' },
      );
      expect(infected.status).toBe('REJECTED_MALWARE');
      const tooBig = await t
        .http()
        .post('/api/v1/documents/upload-intent')
        .set(bearer(user.accessToken))
        .send({
          typeCode: 'PHOTO',
          owner: { type: 'PROFESSIONAL', id: proId },
          fileName: 'a.png',
          mime: 'image/png',
          sizeBytes: 50 * 1024 * 1024,
        })
        .expect(422);
      expect(tooBig.body.error.code).toBe('UPLOAD_TOO_LARGE');
    });

    it('keeps versions, hides other owners’ documents and signs download URLs', async () => {
      const a = await readyProfessional('AAAAA1111A');
      const b = await signUpViaOtp(t, t.agent(), { userType: 'PROFESSIONAL' });
      await t.http().post('/api/v1/professionals/me').set(bearer(b.accessToken)).expect(201);

      const v2 = await upload(
        a.accessToken,
        { type: 'PROFESSIONAL', id: a.proId },
        'PHOTO',
        PNG,
        'image/png',
      );
      const list = await t
        .http()
        .get(`/api/v1/documents?ownerType=PROFESSIONAL&ownerId=${a.proId}&includeHistory=true`)
        .set(bearer(a.accessToken))
        .expect(200);
      const photos = (
        list.body.data as Array<{ typeCode: string; status: string; versionNo: number }>
      ).filter((d) => d.typeCode === 'PHOTO');
      expect(photos.map((p) => [p.versionNo, p.status])).toEqual([
        [2, 'UPLOADED'],
        [1, 'SUPERSEDED'],
      ]);

      await t.http().get(`/api/v1/documents/${v2.id}/download-url`).set(bearer(b.accessToken)).expect(404);
      await t
        .http()
        .post('/api/v1/documents/upload-intent')
        .set(bearer(b.accessToken))
        .send({
          typeCode: 'PHOTO',
          owner: { type: 'PROFESSIONAL', id: a.proId },
          fileName: 'x.png',
          mime: 'image/png',
          sizeBytes: 10,
        })
        .expect(404);
      const url = await t
        .http()
        .get(`/api/v1/documents/${v2.id}/download-url`)
        .set(bearer(a.accessToken))
        .expect(200);
      const file = await t.http().get(url.body.data.url).expect(200);
      expect(
        Buffer.from(file.body as Buffer)
          .subarray(0, 4)
          .toString('latin1'),
      ).toBe('\x89PNG');
      await t
        .http()
        .get(url.body.data.url.replace(/sig=[a-f0-9]+/, 'sig=00'))
        .expect(403);
    });
  });

  describe('professional registration journey', () => {
    it('submits, pays online, gets verified and becomes matchable, with balanced ledger entries', async () => {
      const pro = await readyProfessional('BBBBB2222B');
      const ready = await t
        .http()
        .get('/api/v1/registrations/me/readiness')
        .set(bearer(pro.accessToken))
        .expect(200);
      expect(ready.body.data).toMatchObject({ canSubmit: true, missingProfile: [], missingDocuments: [] });

      const submitted = await t
        .http()
        .post('/api/v1/registrations/me/submit')
        .set(bearer(pro.accessToken))
        .expect(200);
      expect(submitted.body.data).toMatchObject({
        providerStatus: 'PENDING_PAYMENT',
        verification: { status: 'NOT_SUBMITTED' },
      });

      const paymentId = await payOnline(pro.accessToken);
      const reg = await t.http().get('/api/v1/registrations/me').set(bearer(pro.accessToken)).expect(200);
      expect(reg.body.data).toMatchObject({
        providerStatus: 'PENDING_VERIFICATION',
        payment: { status: 'PAID', paidPaise: 118_000 },
        verification: { status: 'PENDING' },
      });

      const ledger = await t.connection.collection('ledger_entries').find({ refId: paymentId }).toArray();
      const sum = (k: 'debitPaise' | 'creditPaise') => ledger.reduce((a, e) => a + (e[k] as number), 0);
      expect(sum('debitPaise')).toBe(118_000);
      expect(sum('creditPaise')).toBe(118_000);
      expect(ledger.find((e) => e.account === 'GST_OUTPUT')?.creditPaise).toBe(18_000);

      const regId = reg.body.data.id as string;
      const early = await t
        .http()
        .post(`/api/v1/admin/registrations/${regId}/approve`)
        .set(bearer(superToken))
        .expect(422);
      expect(early.body.error.code).toBe('DOCUMENTS_MISSING');
      for (const id of pro.docIds) {
        // The photo was re-uploaded nowhere here, so both original documents are current.
        await t
          .http()
          .post(`/api/v1/admin/documents/${id}/review`)
          .set(bearer(superToken))
          .send({ decision: 'VERIFIED' })
          .expect(200);
      }
      const detail = await t
        .http()
        .get(`/api/v1/admin/registrations/${regId}`)
        .set(bearer(superToken))
        .expect(200);
      expect(detail.body.data.requiredDocTypeCodes.sort()).toEqual(['PAN_CARD', 'PHOTO']);
      await t.http().post(`/api/v1/admin/registrations/${regId}/approve`).set(bearer(superToken)).expect(200);

      const me = await t.http().get('/api/v1/professionals/me').set(bearer(pro.accessToken)).expect(200);
      expect(me.body.data).toMatchObject({
        status: 'APPROVED',
        isMatchable: true,
        skills: [{ verification: 'VERIFIED' }],
      });
      await t
        .http()
        .patch('/api/v1/professionals/me')
        .set(bearer(pro.accessToken))
        .send({ identity: { idType: 'PAN', idNumber: 'ZZZZZ9999Z' } })
        .expect(409);
    });

    it('refuses to submit an incomplete profile', async () => {
      const user = await signUpViaOtp(t, t.agent(), { userType: 'PROFESSIONAL' });
      await t.http().post('/api/v1/professionals/me').set(bearer(user.accessToken)).expect(201);
      await t
        .http()
        .put('/api/v1/registrations/me/plan')
        .set(bearer(user.accessToken))
        .send({ planCode: 'PRO_TEST' })
        .expect(200);
      const res = await t
        .http()
        .post('/api/v1/registrations/me/submit')
        .set(bearer(user.accessToken))
        .expect(422);
      expect(res.body.error.code).toBe('PROFILE_INCOMPLETE');
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain('Government ID');
    });

    it('blocks a second active profile for the same person and records the conflict', async () => {
      const first = await readyProfessional('CCCCC3333C');
      await t.http().post('/api/v1/registrations/me/submit').set(bearer(first.accessToken)).expect(200);
      const second = await readyProfessional('CCCCC3333C');
      const res = await t
        .http()
        .post('/api/v1/registrations/me/submit')
        .set(bearer(second.accessToken))
        .expect(422);
      expect(res.body.error.code).toBe('PERSON_ALREADY_ACTIVE');
      const conflicts = await t
        .http()
        .get('/api/v1/admin/identity-conflicts')
        .set(bearer(superToken))
        .expect(200);
      expect(conflicts.body.data[0]).toMatchObject({
        status: 'OPEN',
        matchedOn: ['ID'],
        attemptedRole: { type: 'PROFESSIONAL' },
      });
    });

    it('refunds per policy on rejection, with maker-checker on the refund', async () => {
      const pro = await readyProfessional('DDDDD4444D');
      const paymentId = await payOnline(pro.accessToken);
      await t.http().post('/api/v1/registrations/me/submit').set(bearer(pro.accessToken)).expect(200);
      const regId = (await t.http().get('/api/v1/registrations/me').set(bearer(pro.accessToken))).body.data
        .id;
      await t
        .http()
        .post(`/api/v1/admin/registrations/${regId}/reject`)
        .set(bearer(superToken))
        .send({ reason: 'Documents unreadable' })
        .expect(200);

      const refunds = await t
        .http()
        .get('/api/v1/admin/registration-refunds?status=PENDING_APPROVAL')
        .set(bearer(financeToken))
        .expect(200);
      const refund = (
        refunds.body.data as Array<{ id: string; paymentId: string; amountPaise: number }>
      ).find((r) => r.paymentId === paymentId);
      expect(refund?.amountPaise).toBe(118_000);
      const self = await t
        .http()
        .post(`/api/v1/admin/registration-refunds/${refund?.id}/approve`)
        .set(bearer(superToken))
        .set('Idempotency-Key', 'refund-self-001')
        .expect(403);
      expect(self.body.error.code).toBe('MAKER_CHECKER_VIOLATION');
      const ok = await t
        .http()
        .post(`/api/v1/admin/registration-refunds/${refund?.id}/approve`)
        .set(bearer(financeToken))
        .set('Idempotency-Key', 'refund-ok-0001')
        .expect(200);
      expect(ok.body.data.status).toBe('PROCESSED');

      const reg = await t.http().get('/api/v1/registrations/me').set(bearer(pro.accessToken)).expect(200);
      expect(reg.body.data).toMatchObject({
        providerStatus: 'REJECTED',
        payment: { status: 'REFUNDED', refundedPaise: 118_000 },
      });
      const ledger = await t.connection.collection('ledger_entries').find({ refType: 'REFUND' }).toArray();
      expect(ledger.reduce((a, e) => a + (e.debitPaise as number) - (e.creditPaise as number), 0)).toBe(0);
    });
  });

  describe('payment webhooks (FR-WHK-01..05)', () => {
    it('rejects bad signatures, ignores duplicates and never downgrades a captured payment', async () => {
      const pro = await readyProfessional('EEEEE5555E');
      const order = await t
        .http()
        .post('/api/v1/registrations/me/payments/online')
        .set(bearer(pro.accessToken))
        .set('Idempotency-Key', 'wh-order-0001')
        .expect(201);
      const gateway = t.app.get(PaymentGateway) as FakePaymentGateway;
      const fakeOrder = gateway.orders.get(order.body.data.razorpay.orderId);
      if (!fakeOrder) throw new Error('order missing');

      const captured = gateway.webhook('payment.captured', fakeOrder, 'pay_fake_x1');
      await t
        .http()
        .post('/api/v1/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', 'bad')
        .send(captured.body.toString())
        .expect(401);
      for (let i = 0; i < 3; i += 1) {
        const res = await t
          .http()
          .post('/api/v1/webhooks/razorpay')
          .set('Content-Type', 'application/json')
          .set('X-Razorpay-Signature', captured.signature)
          .set('X-Razorpay-Event-Id', captured.eventId)
          .send(captured.body.toString())
          .expect(200);
        expect(res.body.duplicate).toBe(i > 0);
      }
      const failed = gateway.webhook('payment.failed', fakeOrder, 'pay_fake_x1');
      await t
        .http()
        .post('/api/v1/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', failed.signature)
        .set('X-Razorpay-Event-Id', failed.eventId)
        .send(failed.body.toString())
        .expect(200);
      await pump();
      await pump();

      const payments = await t
        .http()
        .get('/api/v1/registrations/me/payments')
        .set(bearer(pro.accessToken))
        .expect(200);
      expect(payments.body.data[0]).toMatchObject({ status: 'SUCCESS', capturedPaise: 118_000 });
      expect(
        await t.connection.collection('ledger_entries').countDocuments({ refId: order.body.data.paymentId }),
      ).toBe(3);
    });
  });

  describe('offline payments', () => {
    it('requires a different person to verify and refuses duplicate references', async () => {
      const pro = await readyProfessional('FFFFF6666F');
      const proof = await upload(
        pro.accessToken,
        { type: 'PROFESSIONAL', id: pro.proId },
        'PAYMENT_PROOF',
        PDF,
        'application/pdf',
      );
      const body = {
        method: 'NEFT',
        reference: 'UTIB000123',
        bank: 'Axis',
        paidOn: '2026-11-10',
        proofDocId: proof.id,
      };
      const rec = await t
        .http()
        .post('/api/v1/registrations/me/payments/offline')
        .set(bearer(pro.accessToken))
        .set('Idempotency-Key', 'off-0001-aaaa')
        .send(body)
        .expect(201);
      expect(rec.body.data.status).toBe('PENDING_VERIFICATION');

      const other = await readyProfessional('GGGGG7777G');
      const otherProof = await upload(
        other.accessToken,
        { type: 'PROFESSIONAL', id: other.proId },
        'PAYMENT_PROOF',
        PDF,
        'application/pdf',
      );
      const dup = await t
        .http()
        .post('/api/v1/registrations/me/payments/offline')
        .set(bearer(other.accessToken))
        .set('Idempotency-Key', 'off-0002-bbbb')
        .send({ ...body, proofDocId: otherProof.id })
        .expect(422);
      expect(dup.body.error.code).toBe('DUPLICATE_PAYMENT_REFERENCE');

      await t
        .http()
        .post(`/api/v1/admin/registration-payments/${rec.body.data.id}/verify`)
        .set(bearer(financeToken))
        .set('Idempotency-Key', 'off-verify-01')
        .expect(200);
      const reg = await t.http().get('/api/v1/registrations/me').set(bearer(pro.accessToken)).expect(200);
      expect(reg.body.data.payment).toMatchObject({ status: 'PAID', paidPaise: 118_000 });
      const ledger = await t.connection
        .collection('ledger_entries')
        .find({ refId: rec.body.data.id })
        .toArray();
      expect(ledger.find((e) => e.account === 'BANK')?.debitPaise).toBe(118_000);
    });
  });

  describe('vendors and workers', () => {
    it('creates a vendor with a scoped admin role and enforces the worker cap under concurrency', async () => {
      const agent = t.agent();
      const owner = await signUpViaOtp(t, agent, { userType: 'VENDOR', name: 'Sharma Facility Services' });
      const created = await agent
        .post('/api/v1/vendors')
        .set(bearer(owner.accessToken))
        .send({
          legalName: 'Sharma Facility Services Pvt Ltd',
          entityType: 'PVT_LTD',
          pan: 'AAACS1234K',
          registeredAddress: { line1: '5 Ring Road', city: 'Delhi', state: 'Delhi', pincode: '110001' },
        })
        .expect(201);
      // The role grant bumped permVersion: refresh to get a token that carries VENDOR_ADMIN.
      const token = (await agent.post('/api/v1/auth/refresh').expect(200)).body.data.accessToken as string;
      const me = await t.http().get('/api/v1/auth/me').set(bearer(token)).expect(200);
      expect(me.body.data.scopes).toContainEqual({ type: 'VENDOR', vendorId: created.body.data.id });

      const worker = (n: number) => ({
        fullName: `Worker ${n}`,
        identity: { idType: 'PAN', idNumber: `WRKRA${1000 + n}A` },
        experienceYears: 3,
        skills: [{ skillId, proficiency: 'INTERMEDIATE', years: 3 }],
        baseLocation: { lat: 28.6, lng: 77.2 },
      });
      const noPlan = await t
        .http()
        .post('/api/v1/vendors/me/workers')
        .set(bearer(token))
        .send(worker(0))
        .expect(422);
      expect(noPlan.body.error.code).toBe('REGISTRATION_PLAN_REQUIRED');

      await t
        .http()
        .put('/api/v1/registrations/me/plan')
        .set(bearer(token))
        .send({ planCode: 'VENDOR_TINY' })
        .expect(200);
      const results = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          t.http().post('/api/v1/vendors/me/workers').set(bearer(token)).send(worker(n)),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      results
        .filter((r) => r.status !== 201)
        .forEach((r) => expect(r.body.error.code).toBe('WORKER_CAP_REACHED'));
      const vendor = await t.http().get('/api/v1/vendors/me').set(bearer(token)).expect(200);
      expect(vendor.body.data).toMatchObject({ workerCap: 2, activeWorkerCount: 2 });

      // Deactivating frees a slot; the freed identity can be re-used.
      const added = results.find((r) => r.status === 201)?.body.data as { id: string };
      await t.http().delete(`/api/v1/vendors/me/workers/${added.id}`).set(bearer(token)).expect(200);
      await t.http().post('/api/v1/vendors/me/workers').set(bearer(token)).send(worker(9)).expect(201);

      // Verification makes the worker matchable.
      const pending = await t
        .http()
        .get('/api/v1/admin/vendor-workers/pending')
        .set(bearer(superToken))
        .expect(200);
      const one = (pending.body.data as Array<{ id: string; vendorId: string }>).find(
        (w) => w.vendorId === created.body.data.id,
      );
      const verified = await t
        .http()
        .post(`/api/v1/admin/vendor-workers/${one?.id}/verify`)
        .set(bearer(superToken))
        .send({ decision: 'APPROVED' })
        .expect(200);
      expect(verified.body.data).toMatchObject({ status: 'ACTIVE', isMatchable: true });
    });

    it('refuses a worker whose ID already belongs to an active professional', async () => {
      const pro = await readyProfessional('HHHHH8888H');
      await t.http().post('/api/v1/registrations/me/submit').set(bearer(pro.accessToken)).expect(200);

      const agent = t.agent();
      const owner = await signUpViaOtp(t, agent, { userType: 'VENDOR' });
      await agent
        .post('/api/v1/vendors')
        .set(bearer(owner.accessToken))
        .send({
          legalName: 'Other Vendor',
          entityType: 'LLP',
          pan: 'AAAFO5678L',
          registeredAddress: { line1: '1 Main', city: 'Pune', state: 'MH', pincode: '411002' },
        })
        .expect(201);
      const token = (await agent.post('/api/v1/auth/refresh').expect(200)).body.data.accessToken as string;
      await t
        .http()
        .put('/api/v1/registrations/me/plan')
        .set(bearer(token))
        .send({ planCode: 'VENDOR_TINY' })
        .expect(200);
      const res = await t
        .http()
        .post('/api/v1/vendors/me/workers')
        .set(bearer(token))
        .send({
          fullName: 'Same Person',
          identity: { idType: 'PAN', idNumber: 'HHHHH8888H' },
          experienceYears: 2,
          skills: [{ skillId, proficiency: 'BEGINNER', years: 1 }],
          baseLocation: { lat: 18.5, lng: 73.8 },
        })
        .expect(422);
      expect(res.body.error.code).toBe('PERSON_ALREADY_ACTIVE');
      const vendor = await t.http().get('/api/v1/vendors/me').set(bearer(token)).expect(200);
      expect(vendor.body.data.activeWorkerCount).toBe(0); // the reserved slot was rolled back
    });
  });
});
