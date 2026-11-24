import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http as mswHttp, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionUser, WorkQueueItem } from '@bijliwala/contracts';
import { AuthProvider } from '@/app/auth';
import { routes } from '@/app/router';
import { tokenStore } from '@/lib/api-client';

const base = '/api/v1';
const ok = (data: unknown) => HttpResponse.json({ success: true, data });
const admin: SessionUser = {
  id: 'a1',
  name: 'Super Admin',
  userType: 'ADMIN',
  roleCodes: ['SUPER_ADMIN'],
  permissions: ['registration.verify', 'company.activate', 'payment.verify'],
  scopes: [{ type: 'PLATFORM' }],
  mfaEnabled: true,
};

let items: WorkQueueItem[] = [];
const server = setupServer(
  mswHttp.post(`${base}/auth/refresh`, () => ok({ accessToken: 'at', expiresIn: 900 })),
  mswHttp.get(`${base}/auth/me`, () => ok(admin)),
  mswHttp.get(`${base}/notifications/unread-count`, () => ok({ count: 0 })),
  mswHttp.get(`${base}/admin/dashboard/work-queue`, () =>
    ok({ items, generatedAt: '2026-11-19T10:00:00.000Z' }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => {
  server.resetHandlers();
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
}

describe('admin dashboard work queue', () => {
  it('shows each waiting queue as a tile linking to the filtered list', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000 - 60_000).toISOString();
    items = [
      { key: 'REGISTRATIONS_TO_VERIFY', count: 3, oldestAt: twoDaysAgo },
      { key: 'OFFLINE_PAYMENTS_TO_VERIFY', count: 0 },
      { key: 'COMPANIES_TO_ACTIVATE', count: 2, oldestAt: twoDaysAgo },
    ];
    renderAt('/admin');
    const registrations = await screen.findByRole('link', { name: 'Registrations to verify: 3' });
    expect(registrations).toHaveAttribute('href', '/admin/verification');
    expect(registrations).toHaveTextContent('Oldest: 2 days');
    expect(screen.getByRole('link', { name: 'Companies to activate: 2' })).toHaveAttribute(
      'href',
      '/admin/companies?status=PENDING_VERIFICATION',
    );
    expect(screen.getByRole('link', { name: 'Offline payments to verify: 0' })).toHaveTextContent(
      'Nothing waiting',
    );
    expect(screen.getByText(/5 items waiting/)).toBeInTheDocument();
    // Only the queues the server returned (the user's permissions) are shown.
    expect(screen.queryByRole('link', { name: /New enquiries/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Providers' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Clients and work' })).toBeInTheDocument();
  });

  it('says all clear when nothing is waiting', async () => {
    items = [{ key: 'REGISTRATIONS_TO_VERIFY', count: 0 }];
    renderAt('/admin');
    expect(await screen.findByText(/All clear/)).toBeInTheDocument();
  });
});
