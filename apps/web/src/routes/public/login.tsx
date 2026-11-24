import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  emailSchema,
  mobileSchema,
  SELF_SIGNUP_USER_TYPES,
  type AuthStepResponse,
  type OtpChallengeResponse,
  type SelfSignupUserType,
  type SessionUser,
} from '@bijliwala/contracts';
import { useAuth } from '@/app/auth';
import { applyServerErrors, FormField } from '@/components/forms/form-field';
import { OtpInput, PhoneInput } from '@/components/forms/inputs';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api-client';
import { formatMobile } from '@/lib/format';
import { cn } from '@/lib/utils';
import { homePathFor } from '@/routes/portals';

const mobileFormSchema = z.object({ mobile: mobileSchema });
type MobileForm = z.infer<typeof mobileFormSchema>;

const signupFormSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(100),
  userType: z.enum(SELF_SIGNUP_USER_TYPES),
  email: z.union([z.literal(''), emailSchema]),
  acceptTerms: z.boolean().refine((v) => v, 'You must accept the terms to continue'),
});
type SignupForm = z.infer<typeof signupFormSchema>;

const USER_TYPE_OPTIONS: Record<SelfSignupUserType, { title: string; text: string }> = {
  COMPANY: { title: 'A business', text: 'I want to hire skilled people for my company or sites.' },
  PROFESSIONAL: { title: 'A professional', text: 'I work in my own name and want job invitations.' },
  VENDOR: { title: 'A vendor or contractor', text: 'I manage a team of workers.' },
};

type Step =
  | { kind: 'mobile' }
  | { kind: 'otp'; challenge: OtpChallengeResponse; mobile: string }
  | { kind: 'signup'; signupToken: string };

/** Mobile + OTP sign-in for providers and company users, with first-time sign-up (FR-AUTH-01). */
export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useAuth();
  const [step, setStep] = useState<Step>({ kind: 'mobile' });
  const [code, setCode] = useState('');

  const finish = async (accessToken: string, user: SessionUser) => {
    await signIn(accessToken, user);
    const from = (location.state as { from?: string } | null)?.from;
    navigate(from && from !== '/login' ? from : homePathFor(user.userType), { replace: true });
  };

  const mobileForm = useForm<MobileForm>({
    resolver: zodResolver(mobileFormSchema),
    defaultValues: { mobile: '' },
  });
  const requestOtp = useMutation({
    mutationFn: (values: MobileForm) => api.post<OtpChallengeResponse>('/auth/otp/request', values),
    onSuccess: (challenge, values) => {
      setCode('');
      setStep({ kind: 'otp', challenge, mobile: values.mobile });
    },
    onError: (err) => applyServerErrors(err, mobileForm.setError),
  });

  const verifyOtp = useMutation({
    mutationFn: (otp: string) =>
      api.post<AuthStepResponse>('/auth/otp/verify', {
        challengeId: step.kind === 'otp' ? step.challenge.challengeId : '',
        code: otp,
      }),
    onSuccess: async (res) => {
      if (res.status === 'AUTHENTICATED') await finish(res.accessToken, res.user);
      else if (res.status === 'SIGNUP_REQUIRED') setStep({ kind: 'signup', signupToken: res.signupToken });
    },
    onError: () => setCode(''),
  });

  const signupForm = useForm<SignupForm>({
    resolver: zodResolver(signupFormSchema),
    defaultValues: { name: '', userType: 'COMPANY', email: '', acceptTerms: false },
  });
  const signup = useMutation({
    mutationFn: (values: SignupForm) =>
      api.post<AuthStepResponse>('/auth/signup', {
        signupToken: step.kind === 'signup' ? step.signupToken : '',
        name: values.name,
        userType: values.userType,
        ...(values.email ? { email: values.email } : {}),
        acceptTerms: true,
      }),
    onSuccess: async (res) => {
      if (res.status === 'AUTHENTICATED') await finish(res.accessToken, res.user);
    },
    onError: (err) => applyServerErrors(err, signupForm.setError),
  });

  const error = (
    step.kind === 'mobile' ? requestOtp.error : step.kind === 'otp' ? verifyOtp.error : signup.error
  ) as ApiError | null;
  // Field-level validation errors are shown next to the fields; everything else as an alert.
  const showError =
    !!error &&
    !(
      error instanceof ApiError &&
      error.isValidation &&
      error.details.some((d) => d.path || d.field) &&
      step.kind !== 'otp'
    );

  return (
    <section className="container flex max-w-md flex-col py-12 sm:py-20">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">
            {step.kind === 'signup' ? 'Create your account' : 'Sign in'}
          </CardTitle>
          <CardDescription>
            {step.kind === 'mobile' && 'Use your mobile number. We will send you a one-time code.'}
            {step.kind === 'otp' && `Enter the 6-digit code sent to ${formatMobile(step.mobile)}.`}
            {step.kind === 'signup' && 'Your number is verified. Tell us a little about yourself.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step.kind === 'mobile' && (
            <form
              className="flex flex-col gap-4"
              onSubmit={mobileForm.handleSubmit((v) => requestOtp.mutate(v))}
              noValidate
            >
              <FormField
                control={mobileForm.control}
                name="mobile"
                label="Mobile number"
                required
                render={(field, a11y) => (
                  <PhoneInput {...a11y} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
                )}
              />
              <Button type="submit" size="lg" loading={requestOtp.isPending}>
                Send code
              </Button>
            </form>
          )}

          {step.kind === 'otp' && (
            <>
              {step.challenge.devCode && (
                <div
                  role="status"
                  className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-warning/50 bg-warning/5 px-3 py-2 text-sm"
                >
                  <span>
                    Development code:{' '}
                    <strong className="tabular tracking-widest">{step.challenge.devCode}</strong>
                  </span>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto px-0"
                    onClick={() => verifyOtp.mutate(step.challenge.devCode as string)}
                  >
                    Use it
                  </Button>
                </div>
              )}
              <OtpInput
                value={code}
                onChange={setCode}
                autoFocus
                aria-invalid={!!verifyOtp.error}
                onComplete={(otp) => verifyOtp.mutate(otp)}
              />
              <Button
                size="lg"
                loading={verifyOtp.isPending}
                disabled={code.length !== 6}
                onClick={() => verifyOtp.mutate(code)}
              >
                Verify and continue
              </Button>
              <div className="flex justify-between text-sm">
                <Button variant="link" className="h-auto px-0" onClick={() => setStep({ kind: 'mobile' })}>
                  Use a different number
                </Button>
                <Button
                  variant="link"
                  className="h-auto px-0"
                  loading={requestOtp.isPending}
                  onClick={() => requestOtp.mutate({ mobile: step.mobile })}
                >
                  Resend code
                </Button>
              </div>
            </>
          )}

          {step.kind === 'signup' && (
            <form
              className="flex flex-col gap-4"
              onSubmit={signupForm.handleSubmit((v) => signup.mutate(v))}
              noValidate
            >
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">I am</legend>
                {SELF_SIGNUP_USER_TYPES.map((type) => {
                  const selected = signupForm.watch('userType') === type;
                  return (
                    <label
                      key={type}
                      className={cn(
                        'flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors',
                        selected ? 'border-primary bg-accent' : 'hover:bg-muted',
                      )}
                    >
                      <input
                        type="radio"
                        value={type}
                        className="mt-1 accent-primary"
                        {...signupForm.register('userType')}
                      />
                      <span>
                        <span className="block text-sm font-semibold">{USER_TYPE_OPTIONS[type].title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {USER_TYPE_OPTIONS[type].text}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
              <FormField
                control={signupForm.control}
                name="name"
                label="Full name"
                required
                render={(field, a11y) => <Input {...a11y} {...field} autoComplete="name" />}
              />
              <FormField
                control={signupForm.control}
                name="email"
                label="Email (optional)"
                hint="Used for invoices and account notices."
                render={(field, a11y) => <Input {...a11y} {...field} type="email" autoComplete="email" />}
              />
              <FormField
                control={signupForm.control}
                name="acceptTerms"
                label="Terms"
                render={(field, a11y) => (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      {...a11y}
                      checked={field.value}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                    <span>
                      I agree to the terms of service and consent to the processing of my data as described in
                      the privacy policy.
                    </span>
                  </label>
                )}
              />
              <Button type="submit" size="lg" loading={signup.isPending}>
                Create account
              </Button>
            </form>
          )}

          {showError && <Alert>{error.message}</Alert>}

          {step.kind === 'mobile' && (
            <p className="text-center text-sm text-muted-foreground">
              Platform administrator?{' '}
              <Link to="/admin/login" className="font-medium text-primary hover:underline">
                Admin sign-in
              </Link>
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
