import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mswHttp, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@skillconnect/contracts';
import { AuthProvider } from '@/app/auth';
import { routes } from '@/app/router';
import { tokenStore } from '@/lib/api-client';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));

const base = '/api/v1';
const professional: SessionUser = {
  id: 'u1',
  name: 'Asha Kumar',
  userType: 'PROFESSIONAL',
  mobile: '+919812345678',
  roleCodes: ['PROFESSIONAL'],
  permissions: ['profile.self'],
  scopes: [{ type: 'PLATFORM' }],
  mfaEnabled: false,
};
const admin: SessionUser = {
  ...professional,
  id: 'a1',
  name: 'Root Admin',
  userType: 'ADMIN',
  roleCodes: ['SUPER_ADMIN'],
  permissions: ['user.read', 'audit.read'],
  mfaEnabled: true,
};

const calls: Array<{ path: string; body: unknown }> = [];
const server = setupServer(
  mswHttp.post(`${base}/auth/refresh`, () =>
    HttpResponse.json(
      { success: false, error: { code: 'UNAUTHENTICATED', message: 'no session' } },
      { status: 401 },
    ),
  ),
  mswHttp.get(`${base}/public/categories`, () => HttpResponse.json({ success: true, data: [] })),
  mswHttp.get(`${base}/notifications/unread-count`, () =>
    HttpResponse.json({ success: true, data: { count: 3 } }),
  ),
  mswHttp.post(`${base}/auth/otp/request`, async ({ request }) => {
    calls.push({ path: 'otp/request', body: await request.json() });
    return HttpResponse.json({
      success: true,
      data: { challengeId: 'ch1', expiresInSec: 300, resendAfterSec: 30 },
    });
  }),
  mswHttp.post(`${base}/auth/otp/verify`, async ({ request }) => {
    calls.push({ path: 'otp/verify', body: await request.json() });
    return HttpResponse.json({ success: true, data: { status: 'SIGNUP_REQUIRED', signupToken: 'st1' } });
  }),
  mswHttp.post(`${base}/auth/signup`, async ({ request }) => {
    calls.push({ path: 'signup', body: await request.json() });
    return HttpResponse.json({
      success: true,
      data: { status: 'AUTHENTICATED', accessToken: 'at1', expiresIn: 900, user: professional },
    });
  }),
  mswHttp.post(`${base}/auth/admin/login`, () =>
    HttpResponse.json({ success: true, data: { status: 'MFA_ENROLLMENT_REQUIRED', mfaToken: 'mfa1' } }),
  ),
  mswHttp.post(`${base}/auth/admin/mfa/enroll`, () =>
    HttpResponse.json({
      success: true,
      data: { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP' },
    }),
  ),
  mswHttp.post(`${base}/auth/admin/mfa/enroll/confirm`, async ({ request }) => {
    calls.push({ path: 'mfa/confirm', body: await request.json() });
    return HttpResponse.json({
      success: true,
      data: { status: 'AUTHENTICATED', accessToken: 'at2', expiresIn: 900, user: admin },
    });
  }),
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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('mobile OTP sign-up', () => {
  it('goes from mobile number to OTP to sign-up and lands in the provider portal', async () => {
    const router = renderAt('/login');
    await userEvent.type(await screen.findByRole('textbox'), '9812345678');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/Enter the 6-digit code sent to \+91 98123 45678/)).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Digit 1'));
    await userEvent.keyboard('123456');
    expect(await screen.findByText('Create your account')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/A professional/));
    await userEvent.type(screen.getByLabelText(/Full name/), 'Asha Kumar');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('You must accept the terms to continue')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/provider'));
    expect(calls.map((c) => c.path)).toEqual(['otp/request', 'otp/verify', 'signup']);
    expect(calls[0]?.body).toEqual({ mobile: '+919812345678' });
    expect(calls[2]?.body).toEqual({
      signupToken: 'st1',
      name: 'Asha Kumar',
      userType: 'PROFESSIONAL',
      acceptTerms: true,
    });
    expect(tokenStore.get()).toBe('at1');
  });

  it('shows the server error when the OTP request is refused', async () => {
    server.use(
      mswHttp.post(`${base}/auth/otp/request`, () =>
        HttpResponse.json(
          {
            success: false,
            error: {
              code: 'OTP_RESEND_COOLDOWN',
              message: 'Please wait 20 seconds before requesting another code.',
            },
          },
          { status: 429 },
        ),
      ),
    );
    renderAt('/login');
    await userEvent.type(await screen.findByRole('textbox'), '9812345678');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please wait 20 seconds');
  });
});

describe('admin sign-in', () => {
  it('redirects anonymous admins to the admin login', async () => {
    const router = renderAt('/admin/users');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
  });

  it('enrols an authenticator on first sign-in and opens the admin portal', async () => {
    const router = renderAt('/admin/login');
    await userEvent.type(await screen.findByLabelText(/Email/), 'root@test.local');
    await userEvent.type(screen.getByLabelText(/Password/), 'Str0ng-Passw0rd!');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByAltText('QR code for your authenticator app')).toHaveAttribute(
      'src',
      'data:image/png;base64,QR',
    );
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Digit 1'));
    await userEvent.keyboard('654321');

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(calls.find((c) => c.path === 'mfa/confirm')?.body).toEqual({ mfaToken: 'mfa1', totp: '654321' });
    // Navigation shows only what the admin may access, and the unread badge is visible.
    expect(await screen.findByRole('link', { name: 'Users' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Roles' })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
  });
});
