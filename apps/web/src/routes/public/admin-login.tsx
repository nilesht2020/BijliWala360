import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import {
  adminLoginSchema,
  type AdminLoginInput,
  type AuthStepResponse,
  type MfaEnrollmentResponse,
} from '@bijliwala/contracts';
import { useAuth } from '@/app/auth';
import { FormField } from '@/components/forms/form-field';
import { OtpInput } from '@/components/forms/inputs';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@/components/ui/primitives';
import { api, type ApiError } from '@/lib/api-client';

type Step =
  | { kind: 'password' }
  | { kind: 'mfa'; mfaToken: string }
  | { kind: 'enroll'; mfaToken: string; enrollment?: MfaEnrollmentResponse; qr?: string };

/** Admin sign-in: email + password, then an authenticator code; first sign-in enrols TOTP (FR-AUTH-02). */
export default function AdminLoginPage() {
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [code, setCode] = useState('');

  const form = useForm<AdminLoginInput>({
    resolver: zodResolver(adminLoginSchema),
    defaultValues: { email: '', password: '' },
  });

  const finish = async (res: AuthStepResponse) => {
    if (res.status !== 'AUTHENTICATED') return;
    await signIn(res.accessToken, res.user);
    navigate('/admin', { replace: true });
  };

  const login = useMutation({
    mutationFn: (values: AdminLoginInput) => api.post<AuthStepResponse>('/auth/admin/login', values),
    onSuccess: (res) => {
      setCode('');
      if (res.status === 'MFA_REQUIRED') setStep({ kind: 'mfa', mfaToken: res.mfaToken });
      if (res.status === 'MFA_ENROLLMENT_REQUIRED') setStep({ kind: 'enroll', mfaToken: res.mfaToken });
    },
  });

  const enroll = useMutation({
    mutationFn: (mfaToken: string) => api.post<MfaEnrollmentResponse>('/auth/admin/mfa/enroll', { mfaToken }),
    onSuccess: async (enrollment, mfaToken) => {
      const qr = await QRCode.toDataURL(enrollment.otpauthUrl, { margin: 1, width: 200 });
      setStep({ kind: 'enroll', mfaToken, enrollment, qr });
    },
  });

  const enrollMfa = enroll.mutate;
  const enrollToken = step.kind === 'enroll' && !step.enrollment ? step.mfaToken : null;
  useEffect(() => {
    if (enrollToken) enrollMfa(enrollToken);
  }, [enrollToken, enrollMfa]);

  const verify = useMutation({
    mutationFn: (totp: string) => {
      if (step.kind === 'password') throw new Error('Invalid step');
      const path = step.kind === 'enroll' ? '/auth/admin/mfa/enroll/confirm' : '/auth/admin/mfa/verify';
      return api.post<AuthStepResponse>(path, { mfaToken: step.mfaToken, totp });
    },
    onSuccess: finish,
    onError: () => setCode(''),
  });

  const error = (login.error ?? enroll.error ?? verify.error) as ApiError | null;

  return (
    <section className="container flex max-w-md flex-col py-12 sm:py-20">
      <Card>
        <CardHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-accent text-primary">
            <ShieldCheck className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-2xl">Admin sign-in</CardTitle>
          <CardDescription>
            {step.kind === 'password' && 'Sign in with your work email and password.'}
            {step.kind === 'mfa' && 'Enter the 6-digit code from your authenticator app.'}
            {step.kind === 'enroll' &&
              'Two-factor authentication is required. Scan the code with an authenticator app, then enter the 6-digit code it shows.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step.kind === 'password' && (
            <form
              className="flex flex-col gap-4"
              onSubmit={form.handleSubmit((v) => login.mutate(v))}
              noValidate
            >
              <FormField
                control={form.control}
                name="email"
                label="Email"
                required
                render={(field, a11y) => <Input {...a11y} {...field} type="email" autoComplete="username" />}
              />
              <FormField
                control={form.control}
                name="password"
                label="Password"
                required
                render={(field, a11y) => (
                  <Input {...a11y} {...field} type="password" autoComplete="current-password" />
                )}
              />
              <Button type="submit" size="lg" loading={login.isPending}>
                Continue
              </Button>
              <Link
                to="/forgot-password"
                className="text-center text-sm font-medium text-primary hover:underline"
              >
                Forgot your password?
              </Link>
            </form>
          )}

          {step.kind === 'enroll' && (
            <div className="flex flex-col items-center gap-3">
              {step.qr ? (
                <img
                  src={step.qr}
                  alt="QR code for your authenticator app"
                  className="size-48 rounded-lg border"
                />
              ) : (
                <div className="size-48 animate-pulse rounded-lg bg-muted" aria-hidden />
              )}
              {step.enrollment && (
                <p className="text-center text-xs text-muted-foreground">
                  Can&apos;t scan? Enter this key manually:
                  <code className="mt-1 block break-all rounded bg-muted px-2 py-1 font-mono text-foreground">
                    {step.enrollment.secret}
                  </code>
                </p>
              )}
            </div>
          )}

          {step.kind !== 'password' && (
            <>
              <OtpInput
                value={code}
                onChange={setCode}
                autoFocus
                aria-invalid={!!verify.error}
                onComplete={(c) => verify.mutate(c)}
              />
              <Button
                size="lg"
                loading={verify.isPending}
                disabled={code.length !== 6}
                onClick={() => verify.mutate(code)}
              >
                {step.kind === 'enroll' ? 'Turn on two-factor and sign in' : 'Verify and sign in'}
              </Button>
              <Button variant="link" onClick={() => setStep({ kind: 'password' })}>
                Start again
              </Button>
            </>
          )}

          {error && <Alert>{error.message}</Alert>}
        </CardContent>
      </Card>
    </section>
  );
}
