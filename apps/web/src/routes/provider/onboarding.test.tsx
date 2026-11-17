import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mswHttp, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionUser } from '@skillconnect/contracts';
import { AuthProvider } from '@/app/auth';
import { routes } from '@/app/router';
import { documentUploadApi } from '@/features/providers/api';
import { tokenStore } from '@/lib/api-client';

const base = '/api/v1';
const ok = (data: unknown) => HttpResponse.json({ success: true, data });
const user = (userType: SessionUser['userType']): SessionUser => ({
  id: 'u1',
  name: 'Asha Kumar',
  userType,
  roleCodes: [],
  permissions: userType === 'PROFESSIONAL' ? ['profile.self', 'document.upload', 'document.read'] : [],
  scopes: [{ type: 'PLATFORM' }],
  mfaEnabled: false,
});

let me: SessionUser = user('PROFESSIONAL');
const calls: string[] = [];
const server = setupServer(
  mswHttp.post(`${base}/auth/refresh`, () => ok({ accessToken: 'at', expiresIn: 900 })),
  mswHttp.get(`${base}/auth/me`, () => ok(me)),
  mswHttp.get(`${base}/notifications/unread-count`, () => ok({ count: 0 })),
  mswHttp.get(`${base}/professionals/me`, () =>
    HttpResponse.json(
      { success: false, error: { code: 'PROVIDER_PROFILE_MISSING', message: 'missing' } },
      { status: 404 },
    ),
  ),
  mswHttp.post(`${base}/professionals/me`, () => {
    calls.push('create-professional');
    return ok({ id: 'p1' });
  }),
  mswHttp.get(`${base}/vendors/me`, () =>
    HttpResponse.json({ success: false, error: { code: 'FORBIDDEN', message: 'no' } }, { status: 403 }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => {
  server.resetHandlers();
  calls.length = 0;
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

describe('provider onboarding', () => {
  it('lets a new professional start their profile', async () => {
    me = user('PROFESSIONAL');
    renderAt('/provider/onboarding');
    await userEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(calls).toContain('create-professional'));
  });

  it('asks a new vendor to register the business first', async () => {
    me = user('VENDOR');
    renderAt('/provider/onboarding');
    expect(await screen.findByText('Register your business')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create vendor profile' }));
    expect(await screen.findByText('Enter a valid PAN')).toBeInTheDocument();
  });

  it('hides the Workers menu from professionals', async () => {
    me = user('PROFESSIONAL');
    renderAt('/provider');
    expect(await screen.findAllByRole('link', { name: /Registration/ })).not.toHaveLength(0);
    expect(screen.queryByRole('link', { name: /Workers/ })).not.toBeInTheDocument();
  });
});

describe('document upload adapter', () => {
  it('turns a rejected scan into an error the upload widget can show', async () => {
    server.use(
      mswHttp.post(`${base}/documents/d1/complete`, () =>
        ok({
          id: 'd1',
          status: 'REJECTED_TYPE',
          rejectionReason: 'The file content does not match an allowed file type.',
        }),
      ),
    );
    const adapter = documentUploadApi({ typeCode: 'PAN_CARD', owner: { type: 'PROFESSIONAL', id: 'p1' } });
    await expect(adapter.complete('d1')).rejects.toThrow('does not match an allowed file type');
  });
});
