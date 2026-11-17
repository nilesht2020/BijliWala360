import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { emailSchema, passwordSchema } from '@skillconnect/contracts';
import { applyServerErrors, FormField } from '@/components/forms/form-field';
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

const forgotSchema = z.object({ email: emailSchema });

export function ForgotPasswordPage() {
  const form = useForm<z.infer<typeof forgotSchema>>({
    resolver: zodResolver(forgotSchema),
    defaultValues: { email: '' },
  });
  const forgot = useMutation({ mutationFn: (v: { email: string }) => api.post('/auth/password/forgot', v) });

  return (
    <section className="container flex max-w-md flex-col py-12 sm:py-20">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Reset your password</CardTitle>
          <CardDescription>For administrators and company users who sign in with email.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {forgot.isSuccess ? (
            <Alert tone="success">
              If an account exists for that email, we have sent a link to reset the password. It expires in
              one hour.
            </Alert>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={form.handleSubmit((v) => forgot.mutate(v))}
              noValidate
            >
              <FormField
                control={form.control}
                name="email"
                label="Email"
                required
                render={(field, a11y) => <Input {...a11y} {...field} type="email" autoComplete="email" />}
              />
              <Button type="submit" size="lg" loading={forgot.isPending}>
                Send reset link
              </Button>
              {forgot.error && <Alert>{(forgot.error as ApiError).message}</Alert>}
            </form>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

const resetSchema = z
  .object({ newPassword: passwordSchema, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const form = useForm<z.infer<typeof resetSchema>>({
    resolver: zodResolver(resetSchema),
    defaultValues: { newPassword: '', confirm: '' },
  });
  const reset = useMutation({
    mutationFn: (v: { newPassword: string }) =>
      api.post('/auth/password/reset', { token, newPassword: v.newPassword }),
    onError: (err) => applyServerErrors(err, form.setError),
  });

  return (
    <section className="container flex max-w-md flex-col py-12 sm:py-20">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Choose a new password</CardTitle>
          <CardDescription>Use at least 12 characters, including letters and numbers.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!token && <Alert>This link is incomplete. Open the link from your email again.</Alert>}
          {reset.isSuccess ? (
            <>
              <Alert tone="success">
                Your password has been changed. All other sessions were signed out.
              </Alert>
              <Button asChild size="lg">
                <Link to="/admin/login">Sign in</Link>
              </Button>
            </>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={form.handleSubmit((v) => reset.mutate(v))}
              noValidate
            >
              <FormField
                control={form.control}
                name="newPassword"
                label="New password"
                required
                render={(field, a11y) => (
                  <Input {...a11y} {...field} type="password" autoComplete="new-password" />
                )}
              />
              <FormField
                control={form.control}
                name="confirm"
                label="Confirm password"
                required
                render={(field, a11y) => (
                  <Input {...a11y} {...field} type="password" autoComplete="new-password" />
                )}
              />
              <Button type="submit" size="lg" loading={reset.isPending} disabled={!token}>
                Save password
              </Button>
              {reset.error && !(reset.error as ApiError).details.length && (
                <Alert>{(reset.error as ApiError).message}</Alert>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
