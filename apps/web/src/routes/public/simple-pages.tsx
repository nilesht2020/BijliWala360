import { Building2, HardHat, MapPinOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/layout/page-parts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';

export function BecomeProviderPage() {
  const options = [
    {
      icon: HardHat,
      title: 'Individual professional',
      text: 'You work in your own name. Register once, get verified, and receive job invitations that match your skills and location.',
    },
    {
      icon: Building2,
      title: 'Vendor or contractor',
      text: 'You manage a team. One registration covers onboarding your workers; respond to jobs with the capacity you have available.',
    },
  ];
  return (
    <section className="container max-w-4xl py-14">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Grow your work with Bijli Wala</h1>
      <p className="mt-3 text-lg text-muted-foreground">
        A one-time registration fee, document verification and admin approval keep the marketplace trustworthy
        for everyone.
      </p>
      <div className="mt-8 grid gap-5 md:grid-cols-2">
        {options.map((o) => (
          <Card key={o.title}>
            <CardHeader>
              <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-accent text-primary">
                <o.icon className="size-5" aria-hidden />
              </div>
              <CardTitle>{o.title}</CardTitle>
              <CardDescription>{o.text}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild className="w-full">
                <Link to="/login">Get started</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section className="container max-w-xl py-20">
      <EmptyState
        icon={MapPinOff}
        title="Page not found"
        description="The page you are looking for does not exist or has moved."
        action={
          <Button asChild>
            <Link to="/">Go home</Link>
          </Button>
        }
      />
    </section>
  );
}
