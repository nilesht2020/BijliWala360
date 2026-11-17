import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mswHttp, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Permission, QuotationView, SessionUser } from '@skillconnect/contracts';
import { AuthProvider } from '@/app/auth';
import { routes } from '@/app/router';
import { tokenStore } from '@/lib/api-client';

const base = '/api/v1';
const ok = (data: unknown) => HttpResponse.json({ success: true, data });
const fail = (status: number, code: string, message = code) =>
  HttpResponse.json({ success: false, error: { code, message } }, { status });

const sessionUser = (userType: SessionUser['userType'], permissions: Permission[]): SessionUser => ({
  id: 'u1',
  name: 'Priya Shah',
  userType,
  roleCodes: [],
  permissions,
  scopes: userType === 'ADMIN' ? [{ type: 'PLATFORM' }] : [{ type: 'COMPANY', companyId: 'c'.repeat(24) }],
  mfaEnabled: userType === 'ADMIN',
});

let me: SessionUser = sessionUser('COMPANY', []);
const seen: Array<{ path: string; headers: Record<string, string>; body?: unknown }> = [];

const company = {
  id: 'c'.repeat(24),
  legalName: 'Acme Foods Pvt Ltd',
  panLast4: '234F',
  billingAddress: {
    line1: 'x',
    city: 'Pune',
    state: 'Maharashtra',
    stateCode: '27',
    pincode: '411001',
    country: 'IN',
  },
  status: 'ACTIVE',
  commercialTerms: { creditDays: 15, creditLimitPaise: null, offlinePaymentAllowed: true, advancePct: 0 },
  blockedProviders: [],
  activeSiteCount: 1,
  createdAt: '2026-11-01T00:00:00Z',
  version: 1,
};

const quotation: QuotationView = {
  id: 'q'.repeat(24).replace(/q/g, 'a'),
  quotationNo: 'QT-000007',
  version: 2,
  isLatest: true,
  enquiryId: 'e'.repeat(24),
  enquiryNo: 'ENQ-000003',
  companyId: company.id,
  companyName: company.legalName,
  siteId: 's'.repeat(24).replace(/s/g, 'b'),
  siteName: 'Chakan plant',
  lines: [
    {
      lineId: 'l1',
      skillId: 'k'.repeat(24).replace(/k/g, 'c'),
      skillName: 'Housekeeping',
      description: 'Housekeeping staff',
      headcount: 4,
      unit: 'DAY',
      ratePaise: 90_000,
      quantity: 26,
      sacCode: '998519',
      gstRateBp: 1800,
      amountPaise: 9_360_000,
      discountPaise: 0,
      taxablePaise: 9_360_000,
      cgstPaise: 842_400,
      sgstPaise: 842_400,
      igstPaise: 0,
      taxPaise: 1_684_800,
    },
  ],
  subtotalPaise: 9_360_000,
  discountPaise: 0,
  taxablePaise: 9_360_000,
  tax: { type: 'INTRA', cgstPaise: 842_400, sgstPaise: 842_400, igstPaise: 0, totalTaxPaise: 1_684_800 },
  totalPaise: 11_044_800,
  placeOfSupply: { stateCode: '27', stateName: 'Maharashtra' },
  schedule: {
    startDate: '2030-01-05',
    endDate: '2030-03-31',
    weekdays: [1, 2, 3, 4, 5],
    shift: { startMin: 540, endMin: 1080 },
  },
  paymentTerms: { advancePct: 20, milestones: [] },
  terms: 'Net 15',
  validUntil: '2099-12-31',
  status: 'SENT',
  hasPdf: false,
  createdAt: '2026-11-10T00:00:00Z',
  rev: 0,
};

const server = setupServer(
  mswHttp.post(`${base}/auth/refresh`, () => ok({ accessToken: 'at', expiresIn: 900 })),
  mswHttp.get(`${base}/auth/me`, () => ok(me)),
  mswHttp.get(`${base}/notifications/unread-count`, () => ok({ count: 0 })),
  mswHttp.get(`${base}/public/categories`, () =>
    ok([
      {
        id: 'd'.repeat(24),
        name: 'Facility management',
        slug: 'facility',
        parentId: null,
        level: 1,
        displayOrder: 0,
        isActive: true,
      },
    ]),
  ),
  mswHttp.get(`${base}/public/skills`, () =>
    ok([
      {
        id: quotation.lines[0]?.skillId,
        code: 'HK',
        name: 'Housekeeping',
        categoryIds: [],
        requiredDocTypeCodes: [],
        isActive: true,
      },
    ]),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
  tokenStore.set(null);
});
afterAll(() => server.close());

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('company portal', () => {
  it('asks a new company user to register, validating PAN and the GSTIN/state pair', async () => {
    me = sessionUser('COMPANY', []);
    server.use(mswHttp.get(`${base}/companies/me`, () => fail(404, 'COMPANY_PROFILE_MISSING')));
    renderAt('/company');
    expect(await screen.findByText('Register your company')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Legal name/), 'Acme Foods');
    await userEvent.type(screen.getByLabelText(/Company PAN/), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Register company' }));
    expect(await screen.findByText('Enter a valid PAN')).toBeInTheDocument();
    expect(screen.getByText('Choose a valid state')).toBeInTheDocument();
  });

  it('hides team management from company users without the permission', async () => {
    me = sessionUser('COMPANY', ['enquiry.create', 'job.read']);
    server.use(
      mswHttp.get(`${base}/companies/me`, () => ok(company)),
      mswHttp.get(`${base}/enquiries`, () =>
        HttpResponse.json({ success: true, data: [], meta: { page: 1, pageSize: 5, total: 0 } }),
      ),
      mswHttp.get(`${base}/jobs`, () =>
        HttpResponse.json({ success: true, data: [], meta: { page: 1, pageSize: 5, total: 0 } }),
      ),
    );
    renderAt('/company');
    expect(await screen.findByRole('heading', { name: company.legalName })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Enquiries/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /Team/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Quotations/ })).not.toBeInTheDocument();
  });

  it('accepts a quotation once, with an Idempotency-Key, and opens the new job', async () => {
    me = sessionUser('COMPANY', ['quotation.decide', 'job.read']);
    server.use(
      mswHttp.get(`${base}/companies/me`, () => ok(company)),
      mswHttp.get(`${base}/quotations/${quotation.id}`, () => ok(quotation)),
      mswHttp.post(`${base}/quotations/${quotation.id}/accept`, ({ request }) => {
        seen.push({ path: 'accept', headers: Object.fromEntries(request.headers) });
        return ok({
          quotation: { ...quotation, status: 'ACCEPTED' },
          jobId: 'f'.repeat(24),
          jobNo: 'JOB-000001',
        });
      }),
      mswHttp.get(`${base}/jobs/${'f'.repeat(24)}`, () => fail(404, 'NOT_FOUND', 'Job not found')),
    );
    const router = renderAt(`/company/quotations/${quotation.id}`);
    expect(await screen.findByText('Housekeeping staff')).toBeInTheDocument();
    expect(screen.getByText('CGST')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept quotation' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/company/jobs/${'f'.repeat(24)}`));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  it('blocks acceptance while the company is unverified', async () => {
    me = sessionUser('COMPANY', ['quotation.decide']);
    server.use(
      mswHttp.get(`${base}/companies/me`, () => ok({ ...company, status: 'PENDING_VERIFICATION' })),
      mswHttp.get(`${base}/quotations/${quotation.id}`, () => ok(quotation)),
    );
    renderAt(`/company/quotations/${quotation.id}`);
    expect(await screen.findByRole('button', { name: 'Accept quotation' })).toBeDisabled();
    expect(screen.getByText(/waiting for verification/)).toBeInTheDocument();
  });
});

describe('public request a quote', () => {
  it('submits a lead and shows the reference', async () => {
    me = sessionUser('COMPANY', []);
    server.use(
      mswHttp.post(`${base}/auth/refresh`, () => fail(401, 'UNAUTHENTICATED')),
      mswHttp.post(`${base}/public/enquiries`, async ({ request }) => {
        seen.push({ path: 'lead', headers: {}, body: await request.json() });
        return ok({ enquiryNo: 'ENQ-000042' });
      }),
    );
    renderAt('/request-a-quote');
    await screen.findByRole('heading', { name: 'Request a quote' });
    await userEvent.type(screen.getByLabelText(/Your name/), 'Anil Rao');
    await userEvent.type(screen.getByLabelText(/^Company/), 'Rao Textiles');
    await userEvent.type(screen.getByLabelText(/^Mobile/), '9812345678');
    await userEvent.type(screen.getByLabelText(/^City/), 'Bengaluru');
    await userEvent.selectOptions(await screen.findByLabelText(/^Service/), 'Facility management');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Skill/ }), 'Housekeeping');
    const start = screen.getByLabelText(/Start date/);
    await userEvent.type(start, '2030-01-10');
    await userEvent.type(screen.getByLabelText(/Describe the work/), 'Two cleaners for our office.');
    await userEvent.click(screen.getByRole('button', { name: 'Request quote' }));
    expect(await screen.findByText('ENQ-000042')).toBeInTheDocument();
    const body = seen[0]?.body as { lead: { mobile: string }; website?: string };
    expect(body.lead.mobile).toBe('+919812345678');
    expect(body.website).toBeUndefined();
  });
});

describe('admin quotation builder', () => {
  it('shows live intra-state totals while editing', async () => {
    me = sessionUser('ADMIN', ['enquiry.manage', 'quotation.manage']);
    const enquiry = {
      id: 'e'.repeat(24),
      enquiryNo: 'ENQ-000003',
      source: 'COMPANY',
      companyId: company.id,
      companyName: company.legalName,
      categoryId: 'd'.repeat(24),
      categoryName: 'Facility management',
      siteId: quotation.siteId,
      siteName: 'Chakan plant',
      lines: [{ skillId: quotation.lines[0]?.skillId, skillName: 'Housekeeping', headcount: 2 }],
      schedule: {
        startDate: '2030-01-05',
        endDate: '2030-01-31',
        weekdays: [1, 2, 3],
        shift: { startMin: 540, endMin: 1080 },
      },
      description: 'x',
      status: 'IN_REVIEW',
      notes: [],
      createdAt: '2026-11-10T00:00:00Z',
      version: 1,
    };
    server.use(
      mswHttp.get(`${base}/admin/enquiries/${enquiry.id}`, () => ok(enquiry)),
      mswHttp.get(`${base}/admin/quotations/tax-context`, () =>
        ok({
          supplierStateCode: '27',
          placeOfSupplyStateCode: '27',
          defaultGstRateBp: 1800,
          defaultSacCode: '998519',
          defaultValidUntil: '2099-01-01',
        }),
      ),
      mswHttp.get(`${base}/admin/companies/${company.id}/sites`, () =>
        ok([
          {
            id: quotation.siteId,
            companyId: company.id,
            name: 'Chakan plant',
            address: company.billingAddress,
            location: { lat: 1, lng: 1 },
            timezone: 'Asia/Kolkata',
            contact: { name: 'a', mobile: '+919812345678' },
            isActive: true,
          },
        ]),
      ),
    );
    renderAt(`/admin/quotations/new?enquiryId=${enquiry.id}`);
    const totals = await screen.findByTestId('live-totals');
    const rate = screen.getByLabelText('Bill rate');
    await userEvent.type(rate, '1000');
    // 2 people x 26 days x ₹1,000 = ₹52,000 ; 9% CGST = ₹4,680
    await waitFor(() => expect(within(totals).getByText('CGST').nextSibling?.textContent).toBe('₹4,680.00'));
    expect(within(totals).getByText('Total').nextSibling?.textContent).toBe('₹61,360.00');
    expect(within(totals).queryByText('IGST')).not.toBeInTheDocument();
  });
});
