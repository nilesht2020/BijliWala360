import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mswHttp, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionUser } from '@bijliwala/contracts';
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

  describe('profile photo after approval', () => {
    const professional = (status: string) => ({
      id: 'p1',
      userId: 'u1',
      fullName: 'Asha Kumar',
      languages: [],
      categoryIds: [],
      skills: [],
      availability: {},
      status,
      completion: { percent: 100, missing: [] },
      isMatchable: status === 'APPROVED',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    const photoType = {
      code: 'PHOTO',
      name: 'Profile photo',
      ownerTypes: ['PROFESSIONAL', 'VENDOR_WORKER'],
      allowedMime: ['image/jpeg', 'image/png', 'image/webp'],
      maxSizeBytes: 3 * 1024 * 1024,
      hasExpiry: false,
      captureNumber: false,
    };
    const useProfessional = (status: string, docs: unknown[]) =>
      server.use(
        mswHttp.get(`${base}/professionals/me`, () => ok(professional(status))),
        mswHttp.get(`${base}/documents/types`, () => ok([photoType])),
        mswHttp.get(`${base}/documents`, () => ok(docs)),
        mswHttp.get(`${base}/documents/ph1/download-url`, () =>
          ok({ url: '/files/ph1.jpg?sig=1', mime: 'image/jpeg', fileName: 'me.jpg' }),
        ),
      );

    it('shows the approved professional their profile photo', async () => {
      me = user('PROFESSIONAL');
      useProfessional('APPROVED', [
        { id: 'ph1', typeCode: 'PHOTO', status: 'VERIFIED', fileName: 'me.jpg', mime: 'image/jpeg' },
      ]);
      renderAt('/provider/onboarding');
      const img = await screen.findByRole('img', { name: 'Asha Kumar profile photo' });
      expect(img).toHaveAttribute('src', '/files/ph1.jpg?sig=1');
      const card = img.closest('button')?.parentElement as HTMLElement;
      expect(within(card).getByText('Verified')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Change photo/ })).toBeInTheDocument();
    });

    it('offers to add a photo when an approved professional has none', async () => {
      me = user('PROFESSIONAL');
      useProfessional('APPROVED', []);
      renderAt('/provider/onboarding');
      expect(await screen.findByRole('button', { name: /Add profile photo/ })).toBeInTheDocument();
      expect(screen.getByText('AK')).toBeInTheDocument();
    });

    it('does not show the photo card before approval', async () => {
      me = user('PROFESSIONAL');
      useProfessional('PENDING_VERIFICATION', []);
      renderAt('/provider/onboarding');
      expect(await screen.findByText('Registration status')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Add profile photo/ })).not.toBeInTheDocument();
    });
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
