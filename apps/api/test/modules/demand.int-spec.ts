import type { Agent } from 'supertest';
import { OUTBOX_MODEL } from '../../src/core/database/core.schemas';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { CatalogModule } from '../../src/modules/catalog/catalog.module';
import { CompaniesModule } from '../../src/modules/companies/companies.module';
import { DocumentsModule } from '../../src/modules/documents/documents.module';
import { EnquiriesModule } from '../../src/modules/enquiries/enquiries.module';
import { JobsModule } from '../../src/modules/jobs/jobs.module';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { PlatformModule } from '../../src/modules/platform/platform.module';
import { QuotationsModule, QuotationsService } from '../../src/modules/quotations/quotations.module';
import { UsersModule } from '../../src/modules/users/users.module';
import {
  adminSignIn,
  lastOtpFor,
  nextMobile,
  requestOtp,
  seedAdmin,
  signUpViaOtp,
} from '../setup/auth-helpers';
import { createTestApp, type TestApp } from '../setup/harness';

/** PAN / GSTIN pairs that pass the format and consistency checks. */
let panSeq = 1000;
function panPair(state = '27') {
  panSeq += 1;
  const pan = `ABCDE${panSeq}F`;
  return { pan, gstin: `${state}${pan}1Z5` };
}

const address = (stateCode = '27', state = 'Maharashtra', city = 'Pune') => ({
  line1: '1 Industrial Estate',
  city,
  state,
  stateCode,
  pincode: '411001',
});

const site = (name = 'Plant 1') => ({
  name,
  address: address(),
  location: { lat: 18.52, lng: 73.85 },
  contact: { name: 'Site Manager', mobile: nextMobile() },
});

const schedule = {
  startDate: '2030-01-05',
  endDate: '2030-03-31',
  weekdays: [1, 2, 3, 4, 5, 6],
  shift: { startMin: 540, endMin: 1080 },
};

describe('Phase 4: companies, enquiries, quotations and jobs', () => {
  let t: TestApp;
  let superToken: string;
  let opsToken: string;
  let categoryId: string;
  let skillId: string;
  let skill2Id: string;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const api = (path: string) => `/api/v1${path}`;

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
        CompaniesModule,
        EnquiriesModule,
        JobsModule,
        QuotationsModule,
      ],
    });
    superToken = await adminSignIn(t, t.agent(), await seedAdmin(t, ['SUPER_ADMIN']));
    opsToken = await adminSignIn(t, t.agent(), await seedAdmin(t, ['OPS_ADMIN']));
    const cat = await t
      .http()
      .post(api('/admin/categories'))
      .set(bearer(superToken))
      .send({ name: 'Facility' })
      .expect(201);
    categoryId = cat.body.data.id;
    const s1 = await t
      .http()
      .post(api('/admin/skills'))
      .set(bearer(superToken))
      .send({ code: 'HOUSEKEEPING', name: 'Housekeeping', categoryIds: [categoryId] })
      .expect(201);
    const s2 = await t
      .http()
      .post(api('/admin/skills'))
      .set(bearer(superToken))
      .send({ code: 'SECURITY', name: 'Security guard', categoryIds: [categoryId] })
      .expect(201);
    skillId = s1.body.data.id;
    skill2Id = s2.body.data.id;
  });

  beforeEach(async () => {
    await t.redis.flushall();
  });

  afterAll(async () => {
    await t?.close();
  });

  /** A company user with a registered company and one site; token refreshed after the role grant. */
  async function companyWithSite(state = '27') {
    const agent = t.agent();
    const signup = await signUpViaOtp(t, agent, { userType: 'COMPANY', name: 'Priya Shah' });
    const ids = panPair(state);
    const created = await agent
      .post(api('/companies'))
      .set(bearer(signup.accessToken))
      .send({
        legalName: `Acme ${ids.pan}`,
        ...ids,
        billingAddress: address(state, state === '27' ? 'Maharashtra' : 'Karnataka'),
      })
      .expect(201);
    const token = (await agent.post(api('/auth/refresh')).expect(200)).body.data.accessToken as string;
    const s = await t.http().post(api('/companies/me/sites')).set(bearer(token)).send(site()).expect(201);
    return {
      agent,
      token,
      companyId: created.body.data.id as string,
      siteId: s.body.data.id as string,
      mobile: signup.mobile,
    };
  }

  const enquiryBody = (siteId: string) => ({
    categoryId,
    siteId,
    lines: [
      { skillId, headcount: 4, minExperienceYears: 1 },
      { skillId: skill2Id, headcount: 2 },
    ],
    schedule,
    description: 'Housekeeping and security for our Pune plant.',
  });

  const quotationBody = (siteId: string, validUntil = '2099-12-31') => ({
    siteId,
    lines: [
      {
        skillId,
        description: 'Housekeeping staff',
        headcount: 4,
        unit: 'DAY',
        ratePaise: 90_000,
        quantity: 26,
        payRatePaise: 70_000,
      },
      {
        skillId: skill2Id,
        description: 'Security guard',
        headcount: 2,
        unit: 'MONTH',
        ratePaise: 2_500_000,
        quantity: 3,
      },
    ],
    discountPaise: 10_000,
    schedule,
    paymentTerms: { advancePct: 20, milestones: [] },
    terms: 'Payment within 15 days of invoice.',
    validUntil,
  });

  async function quotedEnquiry(c: Awaited<ReturnType<typeof companyWithSite>>, validUntil?: string) {
    const enq = await t
      .http()
      .post(api('/enquiries'))
      .set(bearer(c.token))
      .send(enquiryBody(c.siteId))
      .expect(201);
    const q = await t
      .http()
      .post(api(`/admin/enquiries/${enq.body.data.id}/quotations`))
      .set(bearer(opsToken))
      .send(quotationBody(c.siteId, validUntil))
      .expect(201);
    await t
      .http()
      .post(api(`/admin/quotations/${q.body.data.id}/send`))
      .set(bearer(opsToken))
      .expect(200);
    return {
      enquiryId: enq.body.data.id as string,
      quotationId: q.body.data.id as string,
      quotation: q.body.data,
    };
  }

  async function activate(companyId: string) {
    await t
      .http()
      .post(api(`/admin/companies/${companyId}/activate`))
      .set(bearer(superToken))
      .send({})
      .expect(200);
  }

  it('registers a company, keeps it pending, and lets it raise enquiries but not jobs', async () => {
    const c = await companyWithSite();
    const me = await t.http().get(api('/companies/me')).set(bearer(c.token)).expect(200);
    expect(me.body.data).toMatchObject({
      status: 'PENDING_VERIFICATION',
      activeSiteCount: 1,
      panLast4: expect.any(String),
    });
    expect(me.body.data.pan).toBeUndefined();

    // The same PAN cannot register twice.
    const other = await signUpViaOtp(t, t.agent(), { userType: 'COMPANY' });
    const dup = await t
      .http()
      .post(api('/companies'))
      .set(bearer(other.accessToken))
      .send({ legalName: 'Copy', pan: me.body.data.legalName.split(' ')[1], billingAddress: address() })
      .expect(409);
    expect(dup.body.error.code).toBe('COMPANY_PROFILE_EXISTS');

    // GSTIN must match the billing state and the PAN.
    const bad = await t
      .http()
      .post(api('/companies'))
      .set(bearer(other.accessToken))
      .send({ legalName: 'Mismatch', pan: 'ZZZZZ9999Z', gstin: '29ZZZZZ9999Z1Z5', billingAddress: address() })
      .expect(400);
    expect(bad.body.error.details.some((d: { path: string }) => d.path === 'gstin')).toBe(true);

    const enq = await t
      .http()
      .post(api('/enquiries'))
      .set(bearer(c.token))
      .send(enquiryBody(c.siteId))
      .expect(201);
    expect(enq.body.data).toMatchObject({
      status: 'NEW',
      source: 'COMPANY',
      enquiryNo: expect.stringMatching(/^ENQ-\d{6}$/),
    });
    expect(enq.body.data.notes).toBeUndefined();

    const job = await t
      .http()
      .post(api('/admin/jobs'))
      .set(bearer(superToken))
      .send({
        companyId: c.companyId,
        siteId: c.siteId,
        categoryId,
        title: 'Manual job',
        schedule: { startDate: '2030-01-01', endDate: '2030-01-31', weekdays: [1, 2, 3] },
        positions: [
          {
            skillId,
            title: 'Cleaner',
            shift: { startMin: 480, endMin: 960 },
            required: 2,
            billRatePaise: 80_000,
            billUnit: 'DAY',
          },
        ],
      })
      .expect(422);
    expect(job.body.error.code).toBe('COMPANY_NOT_ACTIVE');
  });

  it('keeps company users out of admin routes and other companies’ data', async () => {
    const a = await companyWithSite();
    const b = await companyWithSite();
    // job.read is a company permission too, but /admin is platform-only.
    await t.http().get(api('/admin/jobs')).set(bearer(a.token)).expect(403);
    await t.http().get(api('/admin/companies')).set(bearer(a.token)).expect(403);
    const enq = await t
      .http()
      .post(api('/enquiries'))
      .set(bearer(b.token))
      .send(enquiryBody(b.siteId))
      .expect(201);
    await t
      .http()
      .get(api(`/enquiries/${enq.body.data.id}`))
      .set(bearer(a.token))
      .expect(404);
    // A site of another company cannot be used.
    const res = await t
      .http()
      .post(api('/enquiries'))
      .set(bearer(a.token))
      .send(enquiryBody(b.siteId))
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('team invites: site-restricted users only see their own sites’ enquiries', async () => {
    const c = await companyWithSite();
    const site2 = await t
      .http()
      .post(api('/companies/me/sites'))
      .set(bearer(c.token))
      .send(site('Warehouse'))
      .expect(201);
    const mobile = nextMobile();
    const team = await t
      .http()
      .post(api('/companies/me/users'))
      .set(bearer(c.token))
      .send({ name: 'Ravi Site', mobile, roleCode: 'COMPANY_USER', siteIds: [site2.body.data.id] })
      .expect(201);
    expect(team.body.data).toHaveLength(2);

    // The invited person signs in with OTP and lands in the existing account.
    const agent: Agent = t.agent();
    const challengeId = await requestOtp(agent, mobile);
    const login = await agent
      .post(api('/auth/otp/verify'))
      .send({ challengeId, code: lastOtpFor(t.app, mobile) })
      .expect(200);
    expect(login.body.data.status).toBe('AUTHENTICATED');
    const userToken = login.body.data.accessToken as string;

    await t.http().post(api('/enquiries')).set(bearer(c.token)).send(enquiryBody(c.siteId)).expect(201);
    await t
      .http()
      .post(api('/enquiries'))
      .set(bearer(c.token))
      .send(enquiryBody(site2.body.data.id))
      .expect(201);
    const list = await t.http().get(api('/enquiries')).set(bearer(userToken)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].siteId).toBe(site2.body.data.id);
    // Restricted users cannot raise enquiries for other sites, nor manage the team.
    await t.http().post(api('/enquiries')).set(bearer(userToken)).send(enquiryBody(c.siteId)).expect(404);
    await t.http().get(api('/companies/me/users')).set(bearer(userToken)).expect(403);

    // A provider's number cannot be invited.
    const pro = await signUpViaOtp(t, t.agent(), { userType: 'PROFESSIONAL' });
    const clash = await t
      .http()
      .post(api('/companies/me/users'))
      .set(bearer(c.token))
      .send({ name: 'Provider', mobile: pro.mobile, roleCode: 'COMPANY_USER' })
      .expect(409);
    expect(clash.body.error.code).toBe('COMPANY_USER_CONFLICT');
  });

  it('public leads: honeypot rejected, conversion required before quoting', async () => {
    const lead = {
      categoryId,
      lines: [{ skillId, headcount: 3 }],
      schedule,
      description: 'Need cleaners for an office in Bengaluru.',
      lead: { name: 'Anil Rao', companyName: 'Rao Textiles', mobile: nextMobile(), city: 'Bengaluru' },
    };
    await t
      .http()
      .post(api('/public/enquiries'))
      .send({ ...lead, website: 'spam' })
      .expect(400);
    const res = await t.http().post(api('/public/enquiries')).send(lead).expect(201);
    const inbox = await t
      .http()
      .get(api('/admin/enquiries?source=PUBLIC_LEAD'))
      .set(bearer(opsToken))
      .expect(200);
    const enquiry = inbox.body.data.find(
      (e: { enquiryNo: string }) => e.enquiryNo === res.body.data.enquiryNo,
    );
    expect(enquiry.lead.companyName).toBe('Rao Textiles');

    const early = await t
      .http()
      .post(api(`/admin/enquiries/${enquiry.id}/quotations`))
      .set(bearer(opsToken))
      .send({ ...quotationBody('0'.repeat(24)) })
      .expect(422);
    expect(early.body.error.code).toBe('LEAD_NOT_CONVERTED');

    const ids = panPair('29');
    const converted = await t
      .http()
      .post(api(`/admin/enquiries/${enquiry.id}/convert-lead`))
      .set(bearer(opsToken))
      .send({
        newCompany: {
          legalName: 'Rao Textiles Pvt Ltd',
          ...ids,
          billingAddress: address('29', 'Karnataka', 'Bengaluru'),
        },
        site: { ...site('Head office'), address: address('29', 'Karnataka', 'Bengaluru') },
      })
      .expect(200);
    expect(converted.body.data).toMatchObject({
      status: 'IN_REVIEW',
      companyName: 'Rao Textiles Pvt Ltd',
      siteName: 'Head office',
    });

    // Inter-state supply (supplier is in Maharashtra, place of supply Karnataka) => IGST.
    const q = await t
      .http()
      .post(api(`/admin/enquiries/${enquiry.id}/quotations`))
      .set(bearer(opsToken))
      .send(quotationBody(converted.body.data.siteId))
      .expect(201);
    expect(q.body.data.tax.type).toBe('INTER');
    expect(q.body.data.tax.igstPaise).toBeGreaterThan(0);
    expect(q.body.data.tax.cgstPaise).toBe(0);
    expect(q.body.data.placeOfSupply).toEqual({ stateCode: '29', stateName: 'Karnataka' });
  });

  it('quotation totals: intra-state CGST+SGST with the discount spread over lines', async () => {
    const c = await companyWithSite('27');
    const { quotation } = await quotedEnquiry(c);
    // 4 x 26 x 900.00 = 93,600.00 ; 2 x 3 x 25,000.00 = 150,000.00 ; subtotal 243,600.00
    expect(quotation.subtotalPaise).toBe(24_360_000);
    expect(quotation.discountPaise).toBe(10_000);
    expect(quotation.taxablePaise).toBe(24_350_000);
    expect(quotation.tax.type).toBe('INTRA');
    expect(quotation.tax.cgstPaise).toBe(quotation.tax.sgstPaise);
    expect(quotation.tax.igstPaise).toBe(0);
    expect(quotation.totalPaise).toBe(quotation.taxablePaise + quotation.tax.totalTaxPaise);
    expect(quotation.lines.reduce((a: number, l: { discountPaise: number }) => a + l.discountPaise, 0)).toBe(
      10_000,
    );
    expect(quotation.lines[0].payRatePaise).toBe(70_000);

    // The company never sees the internal pay rate.
    const seen = await t
      .http()
      .get(api(`/quotations/${quotation.id}`))
      .set(bearer(c.token))
      .expect(200);
    expect(seen.body.data.lines[0].payRatePaise).toBeUndefined();

    const tooMuch = await t
      .http()
      .post(api(`/admin/quotations/${quotation.id}/preview-totals`))
      .set(bearer(opsToken))
      .send({ lines: quotationBody(c.siteId).lines, discountPaise: 999_999_999 })
      .expect(422);
    expect(tooMuch.body.error.code).toBe('DISCOUNT_EXCEEDS_SUBTOTAL');
  });

  it('accepting creates exactly one job, atomically and idempotently', async () => {
    const c = await companyWithSite();
    const { enquiryId, quotationId } = await quotedEnquiry(c);
    // Drafts are invisible; sent quotations are visible.
    const mine = await t.http().get(api('/quotations')).set(bearer(c.token)).expect(200);
    expect(mine.body.data.map((q: { id: string }) => q.id)).toContain(quotationId);

    const pending = await t
      .http()
      .post(api(`/quotations/${quotationId}/accept`))
      .set(bearer(c.token))
      .set('Idempotency-Key', 'accept-pending-0001')
      .expect(422);
    expect(pending.body.error.code).toBe('COMPANY_NOT_ACTIVE');

    await activate(c.companyId);
    const key = 'accept-key-000000001';
    const first = await t
      .http()
      .post(api(`/quotations/${quotationId}/accept`))
      .set(bearer(c.token))
      .set('Idempotency-Key', key)
      .expect(200);
    const replay = await t
      .http()
      .post(api(`/quotations/${quotationId}/accept`))
      .set(bearer(c.token))
      .set('Idempotency-Key', key)
      .expect(200);
    expect(replay.body.data.jobId).toBe(first.body.data.jobId);
    expect(first.body.data.quotation.status).toBe('ACCEPTED');
    expect(first.body.data.jobNo).toMatch(/^JOB-\d{6}$/);

    const again = await t
      .http()
      .post(api(`/quotations/${quotationId}/accept`))
      .set(bearer(c.token))
      .set('Idempotency-Key', 'accept-key-000000002')
      .expect(422);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const jobs = await t.connection
      .collection('jobs')
      .countDocuments({ quotationId: { $exists: true }, companyId: { $exists: true } });
    const forThis = await t.connection.collection('jobs').find({}).toArray();
    expect(forThis.filter((j) => String(j.quotationId) === quotationId)).toHaveLength(1);
    expect(jobs).toBeGreaterThanOrEqual(1);

    const job = await t
      .http()
      .get(api(`/admin/jobs/${first.body.data.jobId}`))
      .set(bearer(opsToken))
      .expect(200);
    expect(job.body.data).toMatchObject({
      status: 'OPEN',
      billingBasis: 'ATTENDANCE',
      totals: { required: 6, held: 0, confirmed: 0 },
    });
    expect(job.body.data.positions[0]).toMatchObject({
      required: 4,
      available: 4,
      minExperienceYears: 1,
      payRatePaise: 70_000,
    });

    const companyView = await t
      .http()
      .get(api(`/jobs/${first.body.data.jobId}`))
      .set(bearer(c.token))
      .expect(200);
    expect(companyView.body.data.positions[0].payRatePaise).toBeUndefined();
    expect(companyView.body.data.statusHistory).toBeUndefined();

    const enquiry = await t
      .http()
      .get(api(`/admin/enquiries/${enquiryId}`))
      .set(bearer(opsToken))
      .expect(200);
    expect(enquiry.body.data.status).toBe('ACCEPTED');
    const decision = await t.connection
      .collection('quotations')
      .findOne({ quotationNo: first.body.data.quotation.quotationNo });
    expect(decision?.decision?.by).toBeDefined();
  });

  it('concurrent acceptances with different keys create a single job', async () => {
    const c = await companyWithSite();
    await activate(c.companyId);
    const { quotationId } = await quotedEnquiry(c);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        t
          .http()
          .post(api(`/quotations/${quotationId}/accept`))
          .set(bearer(c.token))
          .set('Idempotency-Key', `race-key-${i}-0000000`),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const jobs = await t.connection.collection('jobs').find({}).toArray();
    expect(jobs.filter((j) => String(j.quotationId) === quotationId)).toHaveLength(1);
  });

  it('rejection, revision (v2 supersedes nothing accepted) and expiry', async () => {
    const c = await companyWithSite();
    const { enquiryId, quotationId } = await quotedEnquiry(c);
    await t
      .http()
      .post(api(`/quotations/${quotationId}/reject`))
      .set(bearer(c.token))
      .send({ reason: 'Too expensive' })
      .expect(200);
    let enquiry = await t
      .http()
      .get(api(`/admin/enquiries/${enquiryId}`))
      .set(bearer(opsToken))
      .expect(200);
    expect(enquiry.body.data.status).toBe('REJECTED');

    // Creating a second "first" quotation is refused; revising works.
    await t
      .http()
      .post(api(`/admin/enquiries/${enquiryId}/quotations`))
      .set(bearer(opsToken))
      .send(quotationBody(c.siteId))
      .expect(422);
    const v2 = await t
      .http()
      .post(api(`/admin/quotations/${quotationId}/revise`))
      .set(bearer(opsToken))
      .expect(200);
    expect(v2.body.data).toMatchObject({ version: 2, status: 'DRAFT', isLatest: true });
    const v1 = await t
      .http()
      .get(api(`/admin/quotations/${quotationId}`))
      .set(bearer(opsToken))
      .expect(200);
    expect(v1.body.data).toMatchObject({ status: 'REJECTED', isLatest: false });
    await t
      .http()
      .post(api(`/admin/quotations/${quotationId}/revise`))
      .set(bearer(opsToken))
      .expect(422);

    // Edit with a stale If-Match is refused; a fresh one is accepted.
    await t
      .http()
      .patch(api(`/admin/quotations/${v2.body.data.id}`))
      .set(bearer(opsToken))
      .set('If-Match', '7')
      .send({ ...quotationBody(c.siteId), discountPaise: 0 })
      .expect(409);
    const edited = await t
      .http()
      .patch(api(`/admin/quotations/${v2.body.data.id}`))
      .set(bearer(opsToken))
      .set('If-Match', String(v2.body.data.rev))
      .send({ ...quotationBody(c.siteId), discountPaise: 0 })
      .expect(200);
    expect(edited.body.data.discountPaise).toBe(0);

    await t
      .http()
      .post(api(`/admin/quotations/${v2.body.data.id}/send`))
      .set(bearer(opsToken))
      .expect(200);
    enquiry = await t
      .http()
      .get(api(`/admin/enquiries/${enquiryId}`))
      .set(bearer(opsToken))
      .expect(200);
    expect(enquiry.body.data).toMatchObject({
      status: 'QUOTED',
      latestQuotation: { version: 2, status: 'SENT' },
    });

    // Expiry: the validity date passes.
    await t.connection
      .collection('quotations')
      .updateOne(
        { quotationNo: v2.body.data.quotationNo, version: 2 },
        { $set: { validUntil: '2020-01-01' } },
      );
    const accept = await t
      .http()
      .post(api(`/quotations/${v2.body.data.id}/accept`))
      .set(bearer(c.token))
      .set('Idempotency-Key', 'expired-accept-0001')
      .expect(422);
    expect(['QUOTATION_EXPIRED', 'COMPANY_NOT_ACTIVE']).toContain(accept.body.error.code);
    expect(await t.app.get(QuotationsService).expireDue()).toBeGreaterThanOrEqual(1);
    enquiry = await t
      .http()
      .get(api(`/admin/enquiries/${enquiryId}`))
      .set(bearer(opsToken))
      .expect(200);
    expect(enquiry.body.data.status).toBe('EXPIRED');
  });

  it('renders the quotation PDF behind a signed URL', async () => {
    const c = await companyWithSite();
    const { quotationId } = await quotedEnquiry(c);
    const res = await t
      .http()
      .get(api(`/quotations/${quotationId}/pdf-url`))
      .set(bearer(c.token))
      .expect(200);
    const url = new URL(res.body.data.url, 'http://localhost');
    const file = await t
      .http()
      .get(`${url.pathname}${url.search}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(file.headers['content-disposition']).toMatch(/^inline; filename=".*\.pdf"$/);
  });

  it('job lifecycle: hold/resume, headcount guard, schedule impact, cancellation event', async () => {
    const c = await companyWithSite();
    await activate(c.companyId);
    const { quotationId } = await quotedEnquiry(c);
    const accepted = await t
      .http()
      .post(api(`/quotations/${quotationId}/accept`))
      .set(bearer(c.token))
      .set('Idempotency-Key', 'job-life-000000001')
      .expect(200);
    const jobId = accepted.body.data.jobId as string;

    await t
      .http()
      .post(api(`/admin/jobs/${jobId}/hold`))
      .set(bearer(opsToken))
      .send({ reason: 'Client asked to pause' })
      .expect(200);
    const resumed = await t
      .http()
      .post(api(`/admin/jobs/${jobId}/resume`))
      .set(bearer(opsToken))
      .expect(200);
    expect(resumed.body.data.status).toBe('OPEN');
    await t
      .http()
      .post(api(`/admin/jobs/${jobId}/complete`))
      .set(bearer(opsToken))
      .expect(422);

    // Simulate Phase 5 holding two places on the first position.
    const raw = await t.connection
      .collection('jobs')
      .findOne({ _id: new (await import('mongoose')).Types.ObjectId(jobId) });
    const pos = raw?.positions[0];
    await t.connection
      .collection('jobs')
      .updateOne(
        { _id: raw?._id, 'positions._id': pos._id },
        { $inc: { 'positions.$.held': 2, 'positions.$.available': -2 } },
      );

    const job = (
      await t
        .http()
        .get(api(`/admin/jobs/${jobId}`))
        .set(bearer(opsToken))
        .expect(200)
    ).body.data;
    const positions = job.positions.map((p: Record<string, unknown>) => ({
      id: p.id,
      skillId: p.skillId,
      title: p.title,
      shift: p.shift,
      required: p.required,
      billRatePaise: p.billRatePaise,
      billUnit: p.billUnit,
    }));
    const below = await t
      .http()
      .patch(api(`/admin/jobs/${jobId}`))
      .set(bearer(opsToken))
      .send({ positions: [{ ...positions[0], required: 1 }, positions[1]] })
      .expect(422);
    expect(below.body.error.code).toBe('JOB_HEADCOUNT_BELOW_COMMITTED');
    const removed = await t
      .http()
      .patch(api(`/admin/jobs/${jobId}`))
      .set(bearer(opsToken))
      .send({ positions: [positions[1]] })
      .expect(422);
    expect(removed.body.error.code).toBe('POSITION_HAS_COMMITMENTS');

    const edited = await t
      .http()
      .patch(api(`/admin/jobs/${jobId}`))
      .set(bearer(opsToken))
      .set('If-Match', String(job.version))
      .send({
        schedule: { ...job.schedule, endDate: '2030-04-30' },
        positions: [{ ...positions[0], required: 6 }, positions[1]],
      })
      .expect(200);
    expect(edited.body.data.impact).toEqual([
      expect.objectContaining({ kind: 'SCHEDULE_CHANGED', affected: 2 }),
    ]);
    expect(edited.body.data.job.positions[0]).toMatchObject({ required: 6, held: 2, available: 4 });
    // Stale version is refused.
    await t
      .http()
      .patch(api(`/admin/jobs/${jobId}`))
      .set(bearer(opsToken))
      .set('If-Match', String(job.version))
      .send({ title: 'Renamed job' })
      .expect(409);

    await t
      .http()
      .post(api(`/admin/jobs/${jobId}/cancel`))
      .set(bearer(opsToken))
      .send({ reason: 'Contract withdrawn' })
      .expect(200);
    const events = await t.connection
      .collection(t.connection.model(OUTBOX_MODEL).collection.name)
      .find({ type: 'job.cancelled', aggregateId: jobId })
      .toArray();
    expect(events).toHaveLength(1);
    await t
      .http()
      .post(api(`/admin/jobs/${jobId}/resume`))
      .set(bearer(opsToken))
      .expect(422);
  });
});
