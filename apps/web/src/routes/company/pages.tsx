import { zodResolver } from '@hookform/resolvers/zod';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, ClipboardList, FileDown, MapPin, Plus, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  COMPANY_ROLE_CODES,
  COMPANY_SIZES,
  companyCreateSchema,
  companyUserInviteSchema,
  ENQUIRY_STATUSES,
  JOB_STATUSES,
  siteInputSchema,
  type CompanyCreateInput,
  type CompanyUserInviteInput,
  type CompanyUserView,
  type EnquiryView,
  type JobView,
  type QuotationView,
  type SiteInput,
  type SiteView,
} from '@skillconnect/contracts';
import { useAuth, useCan } from '@/app/auth';
import { DataTable, useListParams } from '@/components/data-table/data-table';
import { applyServerErrors, FormField } from '@/components/forms/form-field';
import { PhoneInput } from '@/components/forms/inputs';
import { ConfirmDialog } from '@/components/layout/confirm-dialog';
import { EmptyState, PageHeader, StatusBadge } from '@/components/layout/page-parts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import {
  newIdempotencyKey,
  openPdf,
  useCompanyEnquiries,
  useCompanyEnquiry,
  useCompanyJob,
  useCompanyJobs,
  useCompanyMutations,
  useCompanyQuotation,
  useCompanyQuotations,
  useEnquiryMutations,
  useMyCompany,
  useMySites,
  useQuotationDecision,
  useSiteMutations,
  useTeam,
  useTeamMutations,
} from '@/features/demand/api';
import {
  ContactFields,
  Detail,
  formatSchedule,
  formatShift,
  GstAddressFields,
  LocationFields,
  PositionsTable,
  QuotationDocument,
  StaffingBar,
} from '@/features/demand/components';
import { EnquiryForm } from '@/features/demand/enquiry-form';
import { toApiError } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMobile, formatMoney, humanize } from '@/lib/format';

/* =============================================================== registration & dashboard */

function RegisterCompany() {
  const { refreshUser } = useAuth();
  const { create } = useCompanyMutations(refreshUser);
  const form = useForm<CompanyCreateInput>({
    resolver: zodResolver(companyCreateSchema) as unknown as Resolver<CompanyCreateInput>,
    defaultValues: {
      legalName: '',
      pan: '',
      billingAddress: { line1: '', city: '', state: '', stateCode: '', pincode: '', country: 'IN' },
    },
  });
  const error = create.error ? toApiError(create.error) : null;
  return (
    <Card className="mx-auto max-w-3xl">
      <CardHeader>
        <CardTitle>Register your company</CardTitle>
        <CardDescription>
          You can raise enquiries straight away. Once SkillConnect verifies your company, you can accept
          quotations and start jobs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={form.handleSubmit((v) =>
            create.mutate(v, { onError: (e) => applyServerErrors(e, form.setError) }),
          )}
        >
          <FormField
            control={form.control}
            name="legalName"
            label="Legal name"
            required
            className="sm:col-span-2"
            render={(f, a) => <Input {...a} {...f} />}
          />
          <FormField
            control={form.control}
            name="pan"
            label="Company PAN"
            required
            render={(f, a) => (
              <Input
                {...a}
                {...f}
                onChange={(e) => f.onChange(e.target.value.toUpperCase())}
                maxLength={10}
              />
            )}
          />
          <FormField
            control={form.control}
            name="gstin"
            label="GSTIN"
            hint="Needed for GST invoices"
            render={(f, a) => (
              <Input
                {...a}
                {...f}
                value={f.value ?? ''}
                maxLength={15}
                onChange={(e) => f.onChange(e.target.value.toUpperCase() || undefined)}
              />
            )}
          />
          <FormField
            control={form.control}
            name="industry"
            label="Industry"
            render={(f, a) => (
              <Input
                {...a}
                {...f}
                value={f.value ?? ''}
                onChange={(e) => f.onChange(e.target.value || undefined)}
              />
            )}
          />
          <FormField
            control={form.control}
            name="size"
            label="Company size"
            render={(f, a) => (
              <Select {...a} value={f.value ?? ''} onChange={(e) => f.onChange(e.target.value || undefined)}>
                <option value="">Not specified</option>
                {COMPANY_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s} employees
                  </option>
                ))}
              </Select>
            )}
          />
          <GstAddressFields
            control={form.control}
            prefix="billingAddress"
            label="Billing address"
            setValue={(n, v) => form.setValue(n, v)}
          />
          {error && !(error.status === 400 && error.details.length > 0) && (
            <Alert className="sm:col-span-2">{error.message}</Alert>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" loading={create.isPending}>
              Register company
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function CompanyStatusBanner({ status, reason }: { status: string; reason?: string | undefined }) {
  if (status === 'ACTIVE') return null;
  return (
    <Alert tone={status === 'SUSPENDED' ? 'danger' : 'warning'} className="mb-4">
      {status === 'SUSPENDED'
        ? `Your company account is suspended${reason ? `: ${reason}` : ''}. Contact SkillConnect support.`
        : 'Your company is waiting for verification. You can raise enquiries now; quotations can be accepted once you are verified.'}
    </Alert>
  );
}

const enquiryColumns: ColumnDef<EnquiryView, unknown>[] = [
  {
    header: 'Enquiry',
    accessorKey: 'enquiryNo',
    cell: ({ row }) => <span className="font-medium">{row.original.enquiryNo}</span>,
  },
  { header: 'Service', id: 'svc', cell: ({ row }) => row.original.categoryName },
  { header: 'Site', id: 'site', cell: ({ row }) => row.original.siteName ?? '—' },
  { header: 'People', id: 'hc', cell: ({ row }) => row.original.lines.reduce((a, l) => a + l.headcount, 0) },
  { header: 'Starts', id: 'start', cell: ({ row }) => formatDate(row.original.schedule.startDate) },
  { header: 'Status', id: 'st', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
];

const jobColumns: ColumnDef<JobView, unknown>[] = [
  {
    header: 'Job',
    accessorKey: 'jobNo',
    cell: ({ row }) => (
      <div>
        <div className="font-medium">{row.original.jobNo}</div>
        <div className="text-xs text-muted-foreground">{row.original.title}</div>
      </div>
    ),
  },
  { header: 'Site', id: 'site', cell: ({ row }) => row.original.siteName },
  {
    header: 'Dates',
    id: 'd',
    cell: ({ row }) =>
      `${formatDate(row.original.schedule.startDate)} – ${formatDate(row.original.schedule.endDate)}`,
  },
  {
    header: 'Staffing',
    id: 'staff',
    cell: ({ row }) => (
      <StaffingBar confirmed={row.original.totals.confirmed} required={row.original.totals.required} />
    ),
  },
  { header: 'Status', id: 'st', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
];

export function CompanyHomePage() {
  const company = useMyCompany();
  const navigate = useNavigate();
  const canEnquire = useCan('enquiry.create');
  const enquiries = useCompanyEnquiries({ page: 1, pageSize: 5 });
  const jobs = useCompanyJobs({ page: 1, pageSize: 5 });

  if (company.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!company.data) return <RegisterCompany />;
  const c = company.data;
  return (
    <>
      <PageHeader
        title={c.legalName}
        description={`${c.billingAddress.city}, ${c.billingAddress.state}`}
        actions={
          canEnquire && (
            <Button onClick={() => navigate('/company/enquiries/new')}>
              <Plus aria-hidden /> New enquiry
            </Button>
          )
        }
      />
      <CompanyStatusBanner status={c.status} reason={c.statusReason} />
      {c.activeSiteCount === 0 && (
        <Alert tone="info" className="mb-4">
          Add your first site so we know where the work happens.{' '}
          <Link className="underline" to="/company/sites">
            Add a site
          </Link>
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent enquiries</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(enquiries.data?.items ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No enquiries yet.</p>
            )}
            {(enquiries.data?.items ?? []).map((e) => (
              <Link
                key={e.id}
                to={`/company/enquiries/${e.id}`}
                className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent"
              >
                <span>
                  <span className="font-medium">{e.enquiryNo}</span>
                  <span className="ml-2 text-sm text-muted-foreground">{e.categoryName}</span>
                </span>
                <StatusBadge status={e.status} />
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(jobs.data?.items ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">Jobs appear here when you accept a quotation.</p>
            )}
            {(jobs.data?.items ?? []).map((j) => (
              <Link
                key={j.id}
                to={`/company/jobs/${j.id}`}
                className="flex items-center justify-between gap-3 rounded-lg border p-3 hover:bg-accent"
              >
                <span className="min-w-0">
                  <span className="font-medium">{j.jobNo}</span>
                  <span className="ml-2 truncate text-sm text-muted-foreground">{j.siteName}</span>
                </span>
                <StaffingBar confirmed={j.totals.confirmed} required={j.totals.required} />
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/* =============================================================== sites */

export function SiteDialog({
  open,
  onOpenChange,
  site,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  site?: SiteView | undefined;
  onSave: (input: SiteInput) => Promise<unknown>;
}) {
  const form = useForm<SiteInput>({
    resolver: zodResolver(siteInputSchema) as unknown as Resolver<SiteInput>,
    values: site
      ? {
          name: site.name,
          address: site.address,
          location: site.location,
          timezone: site.timezone,
          contact: site.contact,
          ...(site.geofenceMeters ? { geofenceMeters: site.geofenceMeters } : {}),
        }
      : {
          name: '',
          address: { line1: '', city: '', state: '', stateCode: '', pincode: '', country: 'IN' },
          location: undefined as never,
          contact: { name: '', mobile: '' },
        },
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{site ? 'Edit site' : 'Add a site'}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={form.handleSubmit(async (v) => {
            setError(null);
            try {
              await onSave(v);
              onOpenChange(false);
              form.reset();
            } catch (e) {
              if (!applyServerErrors(e, form.setError)) setError(toApiError(e).message);
            }
          })}
        >
          <FormField
            control={form.control}
            name="name"
            label="Site name"
            required
            className="sm:col-span-2"
            render={(f, a) => <Input {...a} {...f} placeholder="e.g. Chakan plant" />}
          />
          <GstAddressFields
            control={form.control}
            prefix="address"
            setValue={(n, v) => form.setValue(n, v)}
          />
          <LocationFields
            control={form.control}
            prefix="location"
            setValue={(n, v) => form.setValue(n, v, { shouldValidate: true })}
          />
          <ContactFields control={form.control} prefix="contact" />
          <FormField
            control={form.control}
            name="geofenceMeters"
            label="Attendance radius (m)"
            hint="Leave empty for the default"
            render={(f, a) => (
              <Input
                {...a}
                type="number"
                min={25}
                value={f.value ?? ''}
                onChange={(e) =>
                  f.onChange(Number.isNaN(e.target.valueAsNumber) ? undefined : e.target.valueAsNumber)
                }
              />
            )}
          />
          {error && <Alert className="sm:col-span-2">{error}</Alert>}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Save site
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SitesPage() {
  const canManage = useCan('site.manage');
  const sites = useMySites();
  const { create, update } = useSiteMutations();
  const [editing, setEditing] = useState<SiteView | undefined>();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Sites"
        description="Locations where SkillConnect people work for you."
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing(undefined);
                setOpen(true);
              }}
            >
              <Plus aria-hidden /> Add site
            </Button>
          )
        }
      />
      {sites.isLoading && <Skeleton className="h-40 w-full" />}
      {sites.data?.length === 0 && (
        <EmptyState
          icon={MapPin}
          title="No sites yet"
          description="Add the address of each plant, office or warehouse."
        />
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {sites.data?.map((s) => (
          <Card key={s.id} className={s.isActive ? '' : 'opacity-60'}>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div>
                <CardTitle>{s.name}</CardTitle>
                <CardDescription>
                  {s.address.line1}, {s.address.city}, {s.address.state} {s.address.pincode}
                </CardDescription>
              </div>
              {!s.isActive && <StatusBadge status="INACTIVE" />}
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {s.contact.name} · {formatMobile(s.contact.mobile)}
              </span>
              {canManage && (
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditing(s);
                      setOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => update.mutate({ id: s.id, input: { isActive: !s.isActive } })}
                  >
                    {s.isActive ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </span>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      <SiteDialog
        open={open}
        onOpenChange={setOpen}
        site={editing}
        onSave={(input) =>
          editing ? update.mutateAsync({ id: editing.id, input }) : create.mutateAsync(input)
        }
      />
    </>
  );
}

/* =============================================================== team */

export function TeamPage() {
  const team = useTeam();
  const sites = useMySites();
  const { invite, remove } = useTeamMutations();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<CompanyUserView | null>(null);
  const form = useForm<CompanyUserInviteInput>({
    resolver: zodResolver(companyUserInviteSchema),
    defaultValues: { name: '', mobile: '', roleCode: 'COMPANY_USER', siteIds: [] },
  });
  const siteName = new Map((sites.data ?? []).map((s) => [s.id, s.name]));
  const inviteError = invite.error ? toApiError(invite.error) : null;
  return (
    <>
      <PageHeader
        title="Team"
        description="People from your company who can use SkillConnect."
        actions={
          <Button onClick={() => setOpen(true)}>
            <UserPlus aria-hidden /> Add member
          </Button>
        }
      />
      {team.isLoading && <Skeleton className="h-40 w-full" />}
      <div className="grid gap-3">
        {team.data?.map((m) => (
          <Card key={m.userId}>
            <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">
                  {m.name} {m.isYou && <span className="text-xs text-muted-foreground">(you)</span>}
                </p>
                <p className="text-sm text-muted-foreground">
                  {m.mobile ? formatMobile(m.mobile) : '—'} · {humanize(m.roleCode.replace('COMPANY_', ''))}
                  {m.isPrimaryContact ? ' · primary contact' : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  {m.siteIds?.length
                    ? `Sites: ${m.siteIds.map((s) => siteName.get(s) ?? '…').join(', ')}`
                    : 'All sites'}
                </p>
              </div>
              {!m.isYou && !m.isPrimaryContact && (
                <Button variant="ghost" size="sm" onClick={() => setRemoving(m)}>
                  <Trash2 aria-hidden /> Remove
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a team member</DialogTitle>
          </DialogHeader>
          <form
            noValidate
            className="grid gap-4"
            onSubmit={form.handleSubmit((v) =>
              invite.mutate(
                { ...v, ...(v.siteIds?.length ? { siteIds: v.siteIds } : { siteIds: undefined }) },
                {
                  onSuccess: () => {
                    setOpen(false);
                    form.reset();
                  },
                  onError: (e) => applyServerErrors(e, form.setError),
                },
              ),
            )}
          >
            <FormField
              control={form.control}
              name="name"
              label="Name"
              required
              render={(f, a) => <Input {...a} {...f} />}
            />
            <FormField
              control={form.control}
              name="mobile"
              label="Mobile"
              required
              hint="They sign in with an OTP sent to this number."
              render={(f, a) => <PhoneInput {...a} value={f.value} onChange={f.onChange} onBlur={f.onBlur} />}
            />
            <FormField
              control={form.control}
              name="roleCode"
              label="Role"
              required
              render={(f, a) => (
                <Select {...a} value={f.value} onChange={f.onChange}>
                  {COMPANY_ROLE_CODES.map((r) => (
                    <option key={r} value={r}>
                      {r === 'COMPANY_ADMIN'
                        ? 'Admin: manages sites, team, quotations and payments'
                        : 'User: raises enquiries, follows jobs'}
                    </option>
                  ))}
                </Select>
              )}
            />
            <FormField
              control={form.control}
              name="siteIds"
              label="Limit to sites"
              hint="Leave all unticked for access to every site."
              render={(f, a) => (
                <div id={a.id} className="grid gap-2">
                  {(sites.data ?? []).map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={(f.value ?? []).includes(s.id)}
                        onChange={(e) =>
                          f.onChange(
                            e.target.checked
                              ? [...(f.value ?? []), s.id]
                              : (f.value ?? []).filter((x) => x !== s.id),
                          )
                        }
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
              )}
            />
            {inviteError && !(inviteError.status === 400 && inviteError.details.length > 0) && (
              <Alert>{inviteError.message}</Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={invite.isPending}>
                Add member
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        description="They will lose access to your company on SkillConnect."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (removing) await remove.mutateAsync(removing.userId);
          setRemoving(null);
        }}
      />
    </>
  );
}

/* =============================================================== enquiries */

export function EnquiriesPage() {
  const navigate = useNavigate();
  const { page, pageSize, filters, setPage, setFilter } = useListParams(['status'] as const);
  const list = useCompanyEnquiries({ page, pageSize, status: filters.status });
  return (
    <>
      <PageHeader
        title="Enquiries"
        description="Tell us what you need; we reply with a quotation."
        actions={
          <Button onClick={() => navigate('/company/enquiries/new')}>
            <Plus aria-hidden /> New enquiry
          </Button>
        }
      />
      <DataTable
        columns={enquiryColumns}
        data={list.data?.items}
        meta={list.data?.meta}
        isLoading={list.isLoading}
        onPageChange={setPage}
        getRowId={(r) => r.id}
        onRowClick={(r) => navigate(`/company/enquiries/${r.id}`)}
        emptyTitle="No enquiries yet"
        toolbar={
          <Select
            aria-label="Status"
            className="sm:w-48"
            value={filters.status ?? ''}
            onChange={(e) => setFilter('status', e.target.value || undefined)}
          >
            <option value="">All statuses</option>
            {ENQUIRY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        }
      />
    </>
  );
}

export function NewEnquiryPage() {
  const navigate = useNavigate();
  const sites = useMySites();
  const { create } = useEnquiryMutations();
  if (sites.isLoading) return <Skeleton className="h-96 w-full" />;
  const active = (sites.data ?? []).filter((s) => s.isActive);
  return (
    <>
      <PageHeader
        title="New enquiry"
        description="Describe the people you need. We usually reply with a quotation within one working day."
      />
      {active.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="Add a site first"
          description="Enquiries are raised for one of your sites."
          action={<Button onClick={() => navigate('/company/sites')}>Go to sites</Button>}
        />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <EnquiryForm
              mode="company"
              sites={active}
              pending={create.isPending}
              error={create.error}
              onSubmit={(v, setError) =>
                create.mutate(
                  {
                    categoryId: v.categoryId,
                    siteId: v.siteId ?? '',
                    lines: v.lines,
                    schedule: v.schedule,
                    description: v.description,
                    ...(v.budgetPaise !== undefined ? { budgetPaise: v.budgetPaise } : {}),
                  } as Parameters<typeof create.mutate>[0],
                  { onSuccess: (e) => navigate(`/company/enquiries/${e.id}`), onError: setError },
                )
              }
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

export function CompanyEnquiryPage() {
  const { id = '' } = useParams();
  const enquiry = useCompanyEnquiry(id);
  const { cancel } = useEnquiryMutations();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  if (enquiry.isLoading) return <Skeleton className="h-64 w-full" />;
  const e = enquiry.data;
  if (!e) return <EmptyState title="Enquiry not found" />;
  return (
    <>
      <Link
        to="/company/enquiries"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Enquiries
      </Link>
      <PageHeader
        title={e.enquiryNo}
        description={`${e.categoryName} · ${e.siteName ?? ''}`}
        actions={
          <>
            <StatusBadge status={e.status} />
            {(e.status === 'NEW' || e.status === 'IN_REVIEW') && (
              <Button variant="outline" size="sm" onClick={() => setCancelling(true)}>
                Cancel enquiry
              </Button>
            )}
          </>
        }
      />
      {e.latestQuotation && e.latestQuotation.status !== 'DRAFT' && (
        <Alert tone={e.latestQuotation.status === 'SENT' ? 'info' : 'success'} className="mb-4">
          Quotation {e.latestQuotation.quotationNo} (v{e.latestQuotation.version}) for{' '}
          {formatMoney(e.latestQuotation.totalPaise)} is {humanize(e.latestQuotation.status).toLowerCase()}.{' '}
          <Link className="font-semibold underline" to={`/company/quotations/${e.latestQuotation.id}`}>
            View quotation
          </Link>
        </Alert>
      )}
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <Detail label="Schedule">{formatSchedule(e.schedule)}</Detail>
          <Detail label="Shift">{formatShift(e.schedule.shift)}</Detail>
          <Detail label="People">
            <ul className="space-y-0.5">
              {e.lines.map((l) => (
                <li key={l.skillId}>
                  {l.headcount} × {l.skillName}
                  {l.minExperienceYears ? ` (${l.minExperienceYears}+ yrs)` : ''}
                </li>
              ))}
            </ul>
          </Detail>
          <Detail label="Budget">
            {e.budgetPaise === undefined ? 'Not given' : formatMoney(e.budgetPaise)}
          </Detail>
          <div className="sm:col-span-2">
            <Detail label="Description">
              <span className="whitespace-pre-line">{e.description}</span>
            </Detail>
          </div>
          {e.statusReason && <Detail label="Note">{e.statusReason}</Detail>}
          <Detail label="Raised">{formatDateTime(e.createdAt)}</Detail>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel this enquiry?"
        confirmLabel="Cancel enquiry"
        destructive
        onConfirm={async () => {
          await cancel.mutateAsync({ id: e.id, reason });
          setCancelling(false);
        }}
      >
        <Label htmlFor="cancel-reason">Reason</Label>
        <Textarea id="cancel-reason" value={reason} onChange={(ev) => setReason(ev.target.value)} rows={3} />
      </ConfirmDialog>
    </>
  );
}

/* =============================================================== quotations */

const quotationColumns: ColumnDef<QuotationView, unknown>[] = [
  {
    header: 'Quotation',
    accessorKey: 'quotationNo',
    cell: ({ row }) => (
      <span className="font-medium">
        {row.original.quotationNo}{' '}
        <span className="text-xs text-muted-foreground">v{row.original.version}</span>
      </span>
    ),
  },
  { header: 'Enquiry', id: 'enq', cell: ({ row }) => row.original.enquiryNo },
  { header: 'Site', id: 'site', cell: ({ row }) => row.original.siteName },
  {
    header: 'Total',
    id: 'tot',
    cell: ({ row }) => <span className="tabular">{formatMoney(row.original.totalPaise)}</span>,
  },
  { header: 'Valid until', id: 'valid', cell: ({ row }) => formatDate(row.original.validUntil) },
  { header: 'Status', id: 'st', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
];

export function QuotationsPage() {
  const navigate = useNavigate();
  const { page, pageSize, filters, setPage, setFilter } = useListParams(['status'] as const);
  const list = useCompanyQuotations({ page, pageSize, status: filters.status });
  return (
    <>
      <PageHeader title="Quotations" description="Review and accept quotations from SkillConnect." />
      <DataTable
        columns={quotationColumns}
        data={list.data?.items}
        meta={list.data?.meta}
        isLoading={list.isLoading}
        onPageChange={setPage}
        getRowId={(r) => r.id}
        onRowClick={(r) => navigate(`/company/quotations/${r.id}`)}
        emptyTitle="No quotations yet"
        emptyDescription="Quotations appear here once we respond to your enquiries."
        toolbar={
          <Select
            aria-label="Status"
            className="sm:w-48"
            value={filters.status ?? ''}
            onChange={(e) => setFilter('status', e.target.value || undefined)}
          >
            <option value="">All statuses</option>
            {['SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'].map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        }
      />
    </>
  );
}

export function CompanyQuotationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const quotation = useCompanyQuotation(id);
  const company = useMyCompany();
  const { accept, reject } = useQuotationDecision(id);
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  // A fresh key per confirmation dialog: retries of the same click replay, a new decision does not.
  const [acceptKey, setAcceptKey] = useState(newIdempotencyKey);
  const [pdfBusy, setPdfBusy] = useState(false);
  if (quotation.isLoading) return <Skeleton className="h-96 w-full" />;
  const q = quotation.data;
  if (!q) return <EmptyState title="Quotation not found" />;
  const decidable = q.status === 'SENT' && q.isLatest;
  const verified = company.data?.status === 'ACTIVE';
  const error = accept.error ? toApiError(accept.error) : reject.error ? toApiError(reject.error) : null;
  return (
    <>
      <Link
        to="/company/quotations"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Quotations
      </Link>
      <PageHeader
        title={`${q.quotationNo} · v${q.version}`}
        description={`For enquiry ${q.enquiryNo} · ${q.siteName}`}
        actions={
          <>
            <StatusBadge status={q.status} />
            <Button
              variant="outline"
              size="sm"
              loading={pdfBusy}
              onClick={async () => {
                setPdfBusy(true);
                try {
                  await openPdf(`/quotations/${q.id}/pdf-url`);
                } finally {
                  setPdfBusy(false);
                }
              }}
            >
              <FileDown aria-hidden /> PDF
            </Button>
          </>
        }
      />
      {decidable && !verified && (
        <CompanyStatusBanner status={company.data?.status ?? 'PENDING_VERIFICATION'} />
      )}
      {error && <Alert className="mb-4">{error.message}</Alert>}
      {q.status === 'ACCEPTED' && q.jobId && (
        <Alert tone="success" className="mb-4">
          Accepted {q.decision ? `by ${q.decision.byName} on ${formatDateTime(q.decision.at)}` : ''}.{' '}
          <Link className="font-semibold underline" to={`/company/jobs/${q.jobId}`}>
            Go to the job
          </Link>
        </Alert>
      )}
      {q.status === 'REJECTED' && q.decision && (
        <Alert tone="warning" className="mb-4">
          Rejected on {formatDateTime(q.decision.at)}: {q.decision.reason}
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardContent className="pt-6">
            <QuotationDocument q={q} />
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardContent className="grid gap-3 pt-6">
              <Detail label="Total incl. GST">
                <span className="text-xl font-semibold tabular">{formatMoney(q.totalPaise)}</span>
              </Detail>
              <Detail label="Valid until">{formatDate(q.validUntil)}</Detail>
              <Detail label="Schedule">{formatSchedule(q.schedule)}</Detail>
              <Detail label="Shift">{formatShift(q.schedule.shift)}</Detail>
              <Detail label="Payment">
                {q.paymentTerms.advancePct > 0 ? `${q.paymentTerms.advancePct}% advance` : 'No advance'}
                {q.paymentTerms.milestones.map((m) => (
                  <div key={m.label} className="text-xs text-muted-foreground">
                    {m.label}: {m.pct}% {humanize(m.due).toLowerCase()}{' '}
                    {m.dueDate ? formatDate(m.dueDate) : ''}
                  </div>
                ))}
              </Detail>
              {decidable && (
                <div className="flex flex-col gap-2 pt-2">
                  <Button
                    disabled={!verified}
                    onClick={() => {
                      setAcceptKey(newIdempotencyKey());
                      setAccepting(true);
                    }}
                  >
                    Accept quotation
                  </Button>
                  <Button variant="outline" onClick={() => setRejecting(true)}>
                    Reject
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
          {q.terms && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Terms</CardTitle>
              </CardHeader>
              <CardContent className="whitespace-pre-line text-sm text-muted-foreground">
                {q.terms}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={accepting}
        onOpenChange={setAccepting}
        title="Accept this quotation?"
        description={`You agree to ${formatMoney(q.totalPaise)} including GST and the terms above. A job is created and we start finding people.`}
        confirmLabel="Accept"
        onConfirm={async () => {
          const res = await accept.mutateAsync(acceptKey);
          setAccepting(false);
          navigate(`/company/jobs/${res.jobId}`);
        }}
      />
      <ConfirmDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title="Reject this quotation?"
        confirmLabel="Reject"
        destructive
        onConfirm={async () => {
          await reject.mutateAsync(reason);
          setRejecting(false);
        }}
      >
        <Label htmlFor="reject-reason">Tell us why, so we can revise it</Label>
        <Textarea id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
      </ConfirmDialog>
    </>
  );
}

/* =============================================================== jobs */

export function CompanyJobsPage() {
  const navigate = useNavigate();
  const { page, pageSize, filters, setPage, setFilter } = useListParams(['status'] as const);
  const list = useCompanyJobs({ page, pageSize, status: filters.status });
  return (
    <>
      <PageHeader title="Jobs" description="Work in progress at your sites." />
      <DataTable
        columns={jobColumns}
        data={list.data?.items}
        meta={list.data?.meta}
        isLoading={list.isLoading}
        onPageChange={setPage}
        getRowId={(r) => r.id}
        onRowClick={(r) => navigate(`/company/jobs/${r.id}`)}
        emptyTitle="No jobs yet"
        emptyDescription="A job is created when you accept a quotation."
        toolbar={
          <Select
            aria-label="Status"
            className="sm:w-48"
            value={filters.status ?? ''}
            onChange={(e) => setFilter('status', e.target.value || undefined)}
          >
            <option value="">All statuses</option>
            {JOB_STATUSES.filter((s) => s !== 'DRAFT').map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        }
      />
    </>
  );
}

export function CompanyJobPage() {
  const { id = '' } = useParams();
  const job = useCompanyJob(id);
  if (job.isLoading) return <Skeleton className="h-64 w-full" />;
  const j = job.data;
  if (!j) return <EmptyState title="Job not found" />;
  return (
    <>
      <Link
        to="/company/jobs"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Jobs
      </Link>
      <PageHeader title={j.jobNo} description={j.title} actions={<StatusBadge status={j.status} />} />
      {j.cancellation && (
        <Alert tone="warning" className="mb-4">
          Cancelled on {formatDateTime(j.cancellation.at)}: {j.cancellation.reason}
        </Alert>
      )}
      <Card className="mb-4">
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-3">
          <Detail label="Site">
            {j.siteName}
            {j.siteCity ? `, ${j.siteCity}` : ''}
          </Detail>
          <Detail label="Schedule">{formatSchedule(j.schedule)}</Detail>
          <Detail label="Staffing">
            <StaffingBar confirmed={j.totals.confirmed} required={j.totals.required} />
          </Detail>
          {j.quotationNo && <Detail label="Quotation">{j.quotationNo}</Detail>}
          <Detail label="Billing">
            {j.billingBasis === 'MILESTONE' ? 'By milestones' : 'By attendance'}
          </Detail>
        </CardContent>
      </Card>
      <PositionsTable positions={j.positions} />
      <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <ClipboardList className="size-4" aria-hidden />
        The names of assigned people appear here once allocations are approved.
      </p>
    </>
  );
}
