import { http as mswHttp, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { paiseToInput, inputToPaise } from '@/components/forms/inputs';
import { statusTone } from '@/components/layout/page-parts';
import { ApiError, createApiClient, tokenStore } from './api-client';
import { formatDate, formatMinuteOfDay, formatMobile, formatMoney, humanize } from './format';

describe('format', () => {
  it('formats paise as Indian rupees', () => {
    expect(formatMoney(12345678)).toBe('₹1,23,456.78');
    expect(formatMoney(null)).toBe('—');
  });

  it('renders calendar dates without timezone shift', () => {
    expect(formatDate('2026-04-01')).toBe('01 Apr 2026');
  });

  it('renders instants in IST', () => {
    expect(formatDate('2026-03-31T20:00:00Z')).toBe('01 Apr 2026');
  });

  it('formats shift minutes, enums and mobiles', () => {
    expect(formatMinuteOfDay(570)).toBe('09:30');
    expect(humanize('PENDING_APPROVAL')).toBe('Pending approval');
    expect(formatMobile('+919812345678')).toBe('+91 98123 45678');
  });
});

describe('money input conversion', () => {
  it.each([
    ['1,234.5', 123450],
    ['0.05', 5],
    ['₹ 10', 1000],
    ['', null],
  ])('inputToPaise(%s) = %s', (text, paise) => {
    expect(inputToPaise(text)).toBe(paise);
  });

  it('rejects more than two decimals', () => {
    expect(Number.isNaN(inputToPaise('1.234'))).toBe(true);
  });

  it('round-trips through the display format', () => {
    expect(paiseToInput(123450)).toBe('1234.50');
    expect(paiseToInput(100)).toBe('1');
    expect(inputToPaise(paiseToInput(987654321) ?? '')).toBe(987654321);
  });
});

describe('statusTone', () => {
  it('maps lifecycle statuses consistently', () => {
    expect(statusTone('APPROVED')).toBe('success');
    expect(statusTone('PENDING_APPROVAL')).toBe('warning');
    expect(statusTone('REJECTED')).toBe('danger');
    expect(statusTone('SOMETHING_NEW')).toBe('neutral');
  });
});

describe('api client', () => {
  const base = 'http://api.test/api/v1';
  let refreshCalls = 0;
  const server = setupServer(
    mswHttp.get(`${base}/ok`, () => HttpResponse.json({ success: true, data: { a: 1 } })),
    mswHttp.get(`${base}/conflict`, () =>
      HttpResponse.json(
        {
          success: false,
          error: { code: 'STATE_CONFLICT', message: 'Changed', details: [{ path: 'x' }] },
          requestId: 'req_1',
        },
        { status: 409 },
      ),
    ),
    mswHttp.get(`${base}/protected`, ({ request }) =>
      request.headers.get('authorization') === 'Bearer fresh'
        ? HttpResponse.json({ success: true, data: 'secret' })
        : HttpResponse.json(
            { success: false, error: { code: 'TOKEN_EXPIRED', message: 'expired' } },
            { status: 401 },
          ),
    ),
    mswHttp.post(`${base}/auth/refresh`, async () => {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return HttpResponse.json({ success: true, data: { accessToken: 'fresh' } });
    }),
  );

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => {
    server.resetHandlers();
    tokenStore.set(null);
    refreshCalls = 0;
  });
  afterAll(() => server.close());

  it('returns the raw envelope on success', async () => {
    const client = createApiClient({ baseURL: base });
    const res = await client.get('/ok');
    expect(res.data).toEqual({ success: true, data: { a: 1 } });
  });

  it('converts error envelopes into ApiError', async () => {
    const client = createApiClient({ baseURL: base });
    const err = await client.get('/conflict').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'STATE_CONFLICT', requestId: 'req_1', isConflict: true });
  });

  it('refreshes once for concurrent 401s and retries each request', async () => {
    tokenStore.set('stale');
    const client = createApiClient({ baseURL: base });
    const results = await Promise.all([
      client.get('/protected'),
      client.get('/protected'),
      client.get('/protected'),
    ]);
    expect(results.map((r) => r.data.data)).toEqual(['secret', 'secret', 'secret']);
    expect(refreshCalls).toBe(1);
    expect(tokenStore.get()).toBe('fresh');
  });

  it('reports session expiry when refresh fails', async () => {
    server.use(mswHttp.post(`${base}/auth/refresh`, () => HttpResponse.json({}, { status: 401 })));
    let expired = false;
    const client = createApiClient({ baseURL: base, onSessionExpired: () => (expired = true) });
    const err = await client.get('/protected').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(expired).toBe(true);
    expect(tokenStore.get()).toBeNull();
  });
});
