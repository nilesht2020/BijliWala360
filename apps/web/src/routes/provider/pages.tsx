import { zodResolver } from '@hookform/resolvers/zod';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRight, Plus, UserMinus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router-dom';
import { ID_TYPES, workerCreateSchema, type WorkerCreateInput, type WorkerView } from '@bijliwala/contracts';
import { useAuth } from '@/app/auth';
import { DataTable } from '@/components/data-table/data-table';
import { applyServerErrors, FormField } from '@/components/forms/form-field';
import { PhoneInput } from '@/components/forms/inputs';
import { ConfirmDialog } from '@/components/layout/confirm-dialog';
import { EmptyState, PageHeader, StatusBadge } from '@/components/layout/page-parts';
import { ServiceCategoryCard } from '@/components/marketing/service-category-card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Skeleton,
} from '@/components/ui/primitives';
import {
  useCategoryDetail,
  useMyProfessional,
  useMyVendor,
  useRegistration,
  useSkills,
  useWorkerMutations,
  useWorkers,
} from '@/features/providers/api';
import type { ApiError } from '@/lib/api-client';
import { humanize } from '@/lib/format';

/* =============================================================== provider home */

export function ProviderHomePage() {
  const { user } = useAuth();
  const isVendor = user?.userType === 'VENDOR';
  const pro = useMyProfessional(!isVendor);
  const vendor = useMyVendor(isVendor);
  const profile = isVendor ? vendor.data : pro.data;
  const registration = useRegistration(!!profile);
  if ((isVendor ? vendor : pro).isLoading) return <Skeleton className="h-48" />;

  return (
    <>
      <PageHeader title={`Hello, ${user?.name.split(' ')[0] ?? 'there'}`} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Registration</CardTitle>
            <CardDescription>
              {profile ? 'Your verification status' : 'Set up your profile to get verified.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {profile && (
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={profile.status} />
                {registration.data?.plan && <Badge>{registration.data.plan.name}</Badge>}
                {registration.data && (
                  <StatusBadge
                    status={registration.data.payment.status}
                    label={`Fee ${humanize(registration.data.payment.status).toLowerCase()}`}
                  />
                )}
              </div>
            )}
            {profile && profile.status !== 'APPROVED' && (
              <p className="text-sm text-muted-foreground">Profile {profile.completion.percent}% complete.</p>
            )}
            <Button
              asChild
              variant={profile?.status === 'APPROVED' ? 'outline' : 'default'}
              className="self-start"
            >
              <Link to="/provider/onboarding">
                {profile
                  ? profile.status === 'APPROVED'
                    ? 'View profile'
                    : 'Continue registration'
                  : 'Start registration'}{' '}
                <ArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
        {isVendor && vendor.data && (
          <Card>
            <CardHeader>
              <CardTitle>Workers</CardTitle>
              <CardDescription>
                {vendor.data.activeWorkerCount} on your roster
                {vendor.data.workerCap
                  ? ` · plan limit ${vendor.data.workerCap}`
                  : vendor.data.workerCap === null
                    ? ' · no limit'
                    : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link to="/provider/workers">Manage workers</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

/* =============================================================== vendor workers */

const workerColumns = (onDeactivate: (w: WorkerView) => void): ColumnDef<WorkerView, unknown>[] => [
  { header: 'Name', accessorKey: 'fullName' },
  {
    header: 'Skills',
    id: 'skills',
    cell: ({ row }) => row.original.skills.map((s) => s.skillName ?? s.skillId).join(', '),
  },
  {
    header: 'ID',
    id: 'id',
    cell: ({ row }) => `${humanize(row.original.identity.idType)} ••${row.original.identity.idLast4}`,
  },
  {
    header: 'Status',
    accessorKey: 'status',
    cell: ({ getValue }) => <StatusBadge status={String(getValue())} />,
  },
  {
    header: '',
    id: 'actions',
    cell: ({ row }) =>
      ['ACTIVE', 'PENDING_VERIFICATION'].includes(row.original.status) && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Deactivate ${row.original.fullName}`}
          onClick={() => onDeactivate(row.original)}
        >
          <UserMinus />
        </Button>
      ),
  },
];

export function WorkersPage() {
  const [page, setPage] = useState(1);
  const vendor = useMyVendor();
  const workers = useWorkers(page, !!vendor.data);
  const { deactivate } = useWorkerMutations();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WorkerView | null>(null);

  if (vendor.isLoading) return <Skeleton className="h-48" />;
  if (!vendor.data) {
    return (
      <EmptyState
        title="Register your business first"
        action={
          <Button asChild>
            <Link to="/provider/onboarding">Start registration</Link>
          </Button>
        }
      />
    );
  }
  const cap = vendor.data.workerCap;
  return (
    <>
      <PageHeader
        title="Workers"
        description={
          cap === undefined
            ? 'Choose a plan to start adding workers.'
            : `${vendor.data.activeWorkerCount} of ${cap ?? 'unlimited'} roster places used. Each worker is verified before they can be allocated.`
        }
        actions={
          <Button
            onClick={() => setAdding(true)}
            disabled={cap !== null && cap !== undefined && vendor.data.activeWorkerCount >= cap}
          >
            <Plus /> Add worker
          </Button>
        }
      />
      <DataTable
        columns={workerColumns(setRemoving)}
        data={workers.data?.items}
        meta={workers.data?.meta}
        isLoading={workers.isLoading}
        onPageChange={setPage}
        getRowId={(w) => w.id}
        emptyTitle="No workers yet"
        emptyDescription="Add the people you want to send to jobs."
        renderMobileCard={(w) => (
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium">{w.fullName}</p>
              <p className="text-xs text-muted-foreground">{w.skills.map((s) => s.skillName).join(', ')}</p>
            </div>
            <StatusBadge status={w.status} />
          </div>
        )}
      />
      {adding && <AddWorkerDialog onClose={() => setAdding(false)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Deactivate ${removing?.fullName}?`}
        description="They will no longer be offered for jobs, and their roster place is freed."
        destructive
        confirmLabel="Deactivate"
        onConfirm={async () => {
          if (removing) await deactivate.mutateAsync(removing.id);
        }}
      />
    </>
  );
}

function AddWorkerDialog({ onClose }: { onClose: () => void }) {
  const skills = useSkills();
  const { create } = useWorkerMutations();
  const form = useForm<WorkerCreateInput>({
    resolver: zodResolver(workerCreateSchema),
    defaultValues: {
      fullName: '',
      identity: { idType: 'AADHAAR', idNumber: '' },
      experienceYears: 1,
      skills: [{ skillId: '', proficiency: 'INTERMEDIATE', years: 1 }],
      baseLocation: { lat: 0, lng: 0 },
    },
  });
  const submit = form.handleSubmit((v) =>
    create.mutate(v, { onSuccess: onClose, onError: (e) => applyServerErrors(e, form.setError) }),
  );
  const err = create.error as ApiError | null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add worker</DialogTitle>
          <DialogDescription>
            A person can be active with only one vendor or as one professional at a time.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit} noValidate>
          <FormField
            control={form.control}
            name="fullName"
            label="Full name"
            required
            className="sm:col-span-2"
            render={(f, a) => <Input {...a} {...f} />}
          />
          <FormField
            control={form.control}
            name="mobile"
            label="Mobile (optional)"
            className="sm:col-span-2"
            render={(f, a) => (
              <PhoneInput {...a} value={f.value} onChange={(v) => f.onChange(v || undefined)} />
            )}
          />
          <FormField
            control={form.control}
            name="identity.idType"
            label="ID type"
            required
            render={(f, a) => (
              <Select {...a} value={f.value} onChange={f.onChange}>
                {ID_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </Select>
            )}
          />
          <FormField
            control={form.control}
            name="identity.idNumber"
            label="ID number"
            required
            render={(f, a) => <Input {...a} {...f} />}
          />
          <FormField
            control={form.control}
            name="skills.0.skillId"
            label="Main skill"
            required
            render={(f, a) => (
              <Select {...a} value={f.value} onChange={f.onChange}>
                <option value="">Choose…</option>
                {skills.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          />
          <FormField
            control={form.control}
            name="experienceYears"
            label="Experience (years)"
            required
            render={(f, a) => (
              <Input
                {...a}
                type="number"
                min={0}
                value={f.value}
                onChange={(e) => {
                  f.onChange(Number(e.target.value));
                  form.setValue('skills.0.years', Number(e.target.value));
                }}
              />
            )}
          />
          <FormField
            control={form.control}
            name="baseLocation.lat"
            label="Base latitude"
            render={(f, a) => (
              <Input
                {...a}
                type="number"
                step="0.00001"
                value={f.value}
                onChange={(e) => f.onChange(Number(e.target.value))}
              />
            )}
          />
          <FormField
            control={form.control}
            name="baseLocation.lng"
            label="Base longitude"
            render={(f, a) => (
              <Input
                {...a}
                type="number"
                step="0.00001"
                value={f.value}
                onChange={(e) => f.onChange(Number(e.target.value))}
              />
            )}
          />
          {err && !err.details.some((d) => d.path) && <Alert className="sm:col-span-2">{err.message}</Alert>}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Add worker
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* =============================================================== public category page */

export function CategoryPage() {
  const { slug = '' } = useParams();
  const detail = useCategoryDetail(slug);
  if (detail.isLoading)
    return (
      <div className="container py-10">
        <Skeleton className="h-64" />
      </div>
    );
  if (!detail.data)
    return (
      <div className="container py-10">
        <EmptyState
          title="Service not found"
          action={
            <Button asChild>
              <Link to="/">Back to services</Link>
            </Button>
          }
        />
      </div>
    );
  const { category, children, skills, breadcrumbs } = detail.data;
  return (
    <section className="container py-10 sm:py-14">
      <nav className="mb-4 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <Link to="/" className="hover:text-foreground">
          Services
        </Link>
        {breadcrumbs.map((b) => (
          <span key={b.id}>
            {' '}
            /{' '}
            <Link to={`/services/${b.slug}`} className="hover:text-foreground">
              {b.name}
            </Link>
          </span>
        ))}
      </nav>
      <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{category.name}</h1>
          {category.description && (
            <p className="mt-3 text-lg text-muted-foreground">{category.description}</p>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            {skills.map((s) => (
              <Badge key={s.id} tone="primary" className="px-3 py-1 text-sm">
                {s.name}
              </Badge>
            ))}
          </div>
          <Button asChild size="lg" className="mt-8">
            <Link to="/login">Request {category.name.toLowerCase()} staff</Link>
          </Button>
        </div>
        <div className="aspect-[4/3] overflow-hidden rounded-3xl bg-gradient-to-br from-accent to-secondary">
          {category.imageUrl && <img src={category.imageUrl} alt="" className="h-full w-full object-cover" />}
        </div>
      </div>
      {children.length > 0 && (
        <div className="mt-12">
          <h2 className="mb-4 text-xl font-semibold">Specialisations</h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {children.map((c) => (
              <ServiceCategoryCard key={c.id} category={c} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
