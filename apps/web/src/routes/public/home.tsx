import { useQuery } from '@tanstack/react-query';
import {
  BadgeCheck,
  CalendarCheck,
  Check,
  ClipboardList,
  Clock,
  HardHat,
  MapPin,
  Quote,
  Search,
  ShieldCheck,
  Sparkle,
  Sparkles,
  Star,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/layout/page-parts';
import { ServiceCategoryCard, type CategoryCardData } from '@/components/marketing/service-category-card';
import { Button } from '@/components/ui/button';
import { Input, Skeleton } from '@/components/ui/primitives';
import { BLOG_POSTS, DELIVERED_PROJECTS, TESTIMONIALS, type DeliveredProject } from '@/content/home';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-client';

const STEPS = [
  {
    icon: ClipboardList,
    title: 'Tell us what you need',
    text: 'Share the skills, headcount, site and schedule. We send a clear quotation.',
  },
  {
    icon: Users,
    title: 'We match verified talent',
    text: 'Our team shortlists professionals and vendors by skill, location and track record.',
  },
  {
    icon: CalendarCheck,
    title: 'Work starts on time',
    text: 'Confirmed staff arrive on site; attendance and invoices stay in one place.',
  },
];

const TRUST = [
  { icon: ShieldCheck, label: 'Documents and identity verified' },
  { icon: BadgeCheck, label: 'Admin-approved allocations only' },
  { icon: CalendarCheck, label: 'Attendance tracked on site' },
];

const BANNERS = [
  {
    icon: HardHat,
    word: 'CREW',
    title: 'Site staffing',
    text: 'Skilled crews, ready when you are',
    tone: 'bg-violet-200 text-violet-950 dark:bg-violet-950 dark:text-violet-100',
    wordTone: 'text-lime-100 dark:text-violet-900',
  },
  {
    icon: Wrench,
    word: 'FIX',
    title: 'Maintenance',
    text: 'Electricians and technicians on call',
    tone: 'bg-amber-200 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
    wordTone: 'text-orange-100 dark:text-amber-900',
  },
  {
    icon: Sparkles,
    word: 'CARE',
    title: 'Housekeeping & security',
    text: 'Facility teams you can trust',
    tone: 'bg-emerald-200 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100',
    wordTone: 'text-teal-50 dark:text-emerald-900',
  },
];

const PROMISES = [
  'Trained and experienced professionals',
  'Documents and background verified',
  'Transparent, quoted pricing',
  'Attendance tracked on every site',
];

const BANNER_INTERVAL_MS = 4500;

/**
 * Hero right panel: an auto-advancing promo banner with dash indicators, then an "Our promises"
 * checklist. Banner art uses a category image when the catalogue has one, otherwise an icon.
 */
function HeroPanel({ categories }: { categories: CategoryCardData[] }) {
  const [active, setActive] = useState(0);
  const images = categories.filter((c) => c.imageUrl).map((c) => c.imageUrl!);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => setActive((i) => (i + 1) % BANNERS.length), BANNER_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [active]);

  return (
    <div className="hidden lg:block">
      <div className="relative aspect-[3/1] overflow-hidden rounded-2xl">
        {BANNERS.map((b, i) => {
          const image = images[i];
          return (
            <div
              key={b.title}
              aria-hidden={i !== active}
              className={`absolute inset-0 transition-opacity duration-700 ${b.tone} ${
                i === active ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            >
              <span
                className={`absolute -bottom-6 left-2 select-none text-[9rem] font-black leading-none tracking-tighter ${b.wordTone}`}
                aria-hidden
              >
                {b.word}
              </span>
              {image ? (
                <img
                  src={image}
                  alt=""
                  className="absolute bottom-0 left-6 h-[90%] w-2/5 rounded-t-xl object-cover"
                />
              ) : (
                <div className="absolute bottom-0 left-8 flex h-[85%] w-1/3 items-center justify-center rounded-t-[2.5rem] bg-background/60">
                  <b.icon className="size-16 opacity-80" aria-hidden />
                </div>
              )}
              <Sparkle className="absolute left-[48%] top-3 size-10 fill-white text-white" aria-hidden />
              <Sparkle className="absolute left-[58%] top-[55%] size-5 fill-white text-white" aria-hidden />
              <div className="absolute right-6 top-1/2 max-w-[45%] -translate-y-1/2 text-right">
                <p className="text-xs font-semibold uppercase tracking-wider opacity-70">{b.title}</p>
                <p className="mt-1 text-xl font-bold leading-snug">{b.text}</p>
              </div>
            </div>
          );
        })}
        <div className="absolute bottom-3 right-4 flex gap-1.5">
          {BANNERS.map((b, i) => (
            <button
              key={b.title}
              type="button"
              aria-label={`Show ${b.title}`}
              aria-current={i === active}
              onClick={() => setActive(i)}
              className={`h-1 rounded-full transition-all ${
                i === active ? 'w-6 bg-white' : 'w-4 bg-white/50 hover:bg-white/80'
              }`}
            />
          ))}
        </div>
      </div>

      <hr className="my-8 border-border" />

      <div>
        <h2 className="flex items-center gap-3 text-xl font-semibold">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          Our promises
        </h2>
        <ul className="mt-5 space-y-4">
          {PROMISES.map((p) => (
            <li key={p} className="flex items-center gap-4 text-muted-foreground">
              <Check className="size-5 shrink-0 text-foreground/70" aria-hidden />
              {p}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [query, setQuery] = useState('');
  const categories = useQuery({
    queryKey: queryKeys.categories.tree(),
    queryFn: () => api.get<CategoryCardData[]>('/public/categories', { level: 1 }),
  });

  const filtered = (categories.data ?? []).filter((c) =>
    c.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <section className="border-b bg-gradient-to-b from-accent/70 to-background">
        <div className="container grid gap-10 py-14 sm:py-20 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <p className="mb-3 inline-flex rounded-full bg-background px-3 py-1 text-xs font-semibold text-primary shadow-sm">
              For facilities, factories, offices and sites
            </p>
            <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              Skilled people for your business,{' '}
              <span className="text-primary">verified and on schedule.</span>
            </h1>
            <p className="mt-4 max-w-xl text-lg text-muted-foreground">
              Staff electricians, technicians, housekeeping, security and more, from individual professionals
              or established vendors, all managed in one place.
            </p>
            <form
              className="mt-8 flex max-w-xl flex-col gap-2 rounded-2xl border bg-background p-2 shadow-card sm:flex-row"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                document.getElementById('services')?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search services"
                  placeholder="Search a service, e.g. electrician"
                  className="h-12 border-0 pl-9 shadow-none focus-visible:ring-0"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Button type="submit" size="lg">
                Find services
              </Button>
            </form>
            <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
              {TRUST.map((t) => (
                <li key={t.label} className="flex items-center gap-2">
                  <t.icon className="size-4 text-success" aria-hidden />
                  {t.label}
                </li>
              ))}
            </ul>
          </div>
          <HeroPanel categories={categories.data ?? []} />
        </div>
      </section>

      <section id="services" className="container py-14 sm:py-16">
        <div className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Services</h2>
            <p className="text-muted-foreground">Pick a category to see what our providers offer.</p>
          </div>
          <Button asChild variant="outline">
            <Link to="/request-a-quote">Hire Us</Link>
          </Button>
        </div>

        {categories.isLoading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="aspect-[4/3.6] rounded-2xl" />
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {filtered.map((c) => (
              <ServiceCategoryCard key={c.slug} category={c} />
            ))}
          </div>
        ) : (
          <EmptyState
            title={query ? 'No matching services' : 'Our service catalogue is being set up'}
            description={
              query
                ? 'Try a different search term.'
                : 'Check back soon, or raise an enquiry and our team will help you directly.'
            }
          />
        )}
      </section>

      <section id="projects" className="border-t">
        <div className="container py-14 sm:py-16">
          <SectionHeading title="Delivered projects" text="A few of the teams we have put on site." />
          <div className="grid gap-5 md:grid-cols-3">
            {DELIVERED_PROJECTS.map((p) => {
              const Icon = PROJECT_ICONS[p.kind];
              return (
                <article
                  key={p.title}
                  className="overflow-hidden rounded-2xl border bg-background shadow-card"
                >
                  <div className="flex h-28 items-center justify-between bg-gradient-to-br from-accent to-secondary px-6">
                    <Icon className="size-10 text-primary" aria-hidden />
                    <span className="rounded-full bg-background/90 px-3 py-1 text-xs font-semibold">
                      {p.sector}
                    </span>
                  </div>
                  <div className="p-6">
                    <h3 className="font-semibold">{p.title}</h3>
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="size-3.5" aria-hidden />
                      {p.location}
                    </p>
                    <p className="mt-3 text-sm text-muted-foreground">{p.summary}</p>
                    <dl className="mt-5 grid grid-cols-2 gap-3 border-t pt-4 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">Headcount</dt>
                        <dd className="font-semibold">{p.headcount}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Duration</dt>
                        <dd className="font-semibold">{p.duration}</dd>
                      </div>
                    </dl>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-t bg-muted/40">
        <div className="container py-14 sm:py-16">
          <h2 className="mb-8 text-2xl font-bold tracking-tight sm:text-3xl">How it works</h2>
          <ol className="grid gap-5 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rounded-2xl border bg-background p-6 shadow-card">
                <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent text-primary">
                  <s.icon className="size-5" aria-hidden />
                </div>
                <p className="text-xs font-semibold text-muted-foreground">Step {i + 1}</p>
                <h3 className="mt-1 font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="testimonials" className="border-t">
        <div className="container py-14 sm:py-16">
          <SectionHeading title="What our clients say" text="Feedback from teams we staff every day." />
          <div className="grid gap-5 md:grid-cols-3">
            {TESTIMONIALS.map((t) => (
              <figure key={t.name} className="flex flex-col rounded-2xl border bg-background p-6 shadow-card">
                <Quote className="size-7 text-primary/40" aria-hidden />
                <div className="mt-3 flex gap-0.5" aria-label={`Rated ${t.rating} out of 5`}>
                  {Array.from({ length: 5 }, (_, i) => (
                    <Star
                      key={i}
                      className={`size-4 ${i < t.rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'}`}
                      aria-hidden
                    />
                  ))}
                </div>
                <blockquote className="mt-3 flex-1 text-sm leading-relaxed">“{t.quote}”</blockquote>
                <figcaption className="mt-5 flex items-center gap-3 border-t pt-4">
                  <span className="flex size-10 items-center justify-center rounded-full bg-accent text-sm font-semibold text-primary">
                    {initials(t.name)}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">{t.name}</span>
                    <span className="block text-xs text-muted-foreground">{t.role}</span>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <section id="blog" className="border-t bg-muted/40">
        <div className="container py-14 sm:py-16">
          <SectionHeading
            title="From our blog"
            text="Guides on staffing, compliance and running sites well."
          />
          <div className="grid gap-5 md:grid-cols-3">
            {BLOG_POSTS.map((b) => (
              <article
                key={b.title}
                className="flex flex-col rounded-2xl border bg-background p-6 shadow-card"
              >
                <span className="w-fit rounded-full bg-accent px-3 py-1 text-xs font-semibold text-primary">
                  {b.category}
                </span>
                <h3 className="mt-4 font-semibold leading-snug">{b.title}</h3>
                <p className="mt-2 flex-1 text-sm text-muted-foreground">{b.excerpt}</p>
                <p className="mt-5 flex items-center gap-2 border-t pt-4 text-xs text-muted-foreground">
                  <time dateTime={b.date}>{formatDate(b.date)}</time>
                  <span aria-hidden>·</span>
                  <span className="flex items-center gap-1">
                    <Clock className="size-3.5" aria-hidden />
                    {b.readMinutes} min read
                  </span>
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

const PROJECT_ICONS: Record<DeliveredProject['kind'], LucideIcon> = {
  staffing: HardHat,
  maintenance: Wrench,
  housekeeping: Sparkles,
  security: ShieldCheck,
};

function SectionHeading({ title, text }: { title: string; text: string }) {
  return (
    <div className="mb-8">
      <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
      <p className="text-muted-foreground">{text}</p>
    </div>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
