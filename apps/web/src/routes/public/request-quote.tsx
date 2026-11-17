import { CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/primitives';
import { usePublicEnquiry } from '@/features/demand/api';
import { EnquiryForm } from '@/features/demand/enquiry-form';

/** Public lead intake (FR-ENQ-01/04). No account needed; we follow up and set up the company. */
export default function RequestQuotePage() {
  const submit = usePublicEnquiry();

  if (submit.isSuccess)
    return (
      <div className="container max-w-xl py-16 text-center">
        <CheckCircle2 className="mx-auto mb-4 size-12 text-success" aria-hidden />
        <h1 className="text-2xl font-bold">Thanks, we have your request</h1>
        <p className="mt-2 text-muted-foreground">
          Your reference is <strong>{submit.data.enquiryNo}</strong>. Our team will call you, set up your
          company account and send a quotation.
        </p>
        <Button asChild className="mt-6">
          <Link to="/">Back to home</Link>
        </Button>
      </div>
    );

  return (
    <div className="container max-w-3xl py-10 sm:py-14">
      <h1 className="text-3xl font-bold tracking-tight">Request a quote</h1>
      <p className="mt-2 text-muted-foreground">
        Tell us who you need and when. Already a customer?{' '}
        <Link className="font-medium text-primary underline" to="/login">
          Sign in
        </Link>{' '}
        to raise the enquiry from your company account.
      </p>
      <Card className="mt-6">
        <CardContent className="pt-6">
          <EnquiryForm
            mode="public"
            submitLabel="Request quote"
            pending={submit.isPending}
            error={submit.error}
            onSubmit={(v, setError) =>
              submit.mutate(
                {
                  categoryId: v.categoryId,
                  lines: v.lines,
                  schedule: v.schedule,
                  description: v.description,
                  lead: v.lead as NonNullable<typeof v.lead>,
                  ...(v.budgetPaise !== undefined ? { budgetPaise: v.budgetPaise } : {}),
                  ...(v.website ? { website: v.website } : {}),
                } as Parameters<typeof submit.mutate>[0],
                { onError: setError },
              )
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
