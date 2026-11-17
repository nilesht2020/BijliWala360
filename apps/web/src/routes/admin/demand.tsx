import { zodResolver } from '@hookform/resolvers/zod';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, FileDown, Plus, Send, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useFieldArray, useForm, useWatch, type Resolver } from 'react-hook-form';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  BILL_UNITS,
  canTransitionJob,
  COMPANY_STATUSES,
  commercialTermsSchema,
  computeTaxTotals,
  ENQUIRY_SOURCES,
  ENQUIRY_STATUSES,
  JOB_STATUSES,
  jobCreateSchema,
  MILESTONE_DUE,
  quotationInputSchema,
  TaxInputError,
  type CommercialTerms,
  type CompanyView,
  type EnquiryView,
  type JobCreateInput,
  type JobImpact,
  type JobView,
  type QuotationInput,
  type QuotationView,
} from '@skillconnect/contracts';
import { useAuth, useCan } from '@/app/auth';
import { DataTable, useListParams } from '@/components/data-table/data-table';
import { applyServerErrors, FormField } from '@/components/forms/form-field';
import { MoneyInput } from '@/components/forms/inputs';
import { ConfirmDialog } from '@/components/layout/confirm-dialog';
import { EmptyState, PageHeader, StatusBadge } from '@/components/layout/page-parts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Alert,
  Card,
  CardContent,
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
  openPdf,
  useAdminCompanies,
  useAdminCompany,
  useAdminCompanyActions,
  useAdminCompanySites,
  useAdminCompanyUsers,
  useAdminCreateJob,
  useAdminEnquiries,
  useAdminEnquiry,
  useAdminEnquiryActions,
  useAdminJob,
  useAdminJobActions,
  useAdminJobs,
  useAdminQuotation,
  useAdminQuotationActions,
  useAdminQuotations,
  useQuotationTaxContext,
} from '@/features/demand/api';
import {
  Detail,
  formatSchedule,
  formatShift,
  GstAddressFields,
  PositionsTable,
  QuotationDocument,
  StaffingBar,
  TimeInput,
  UNIT_LABELS,
  WeekdayPicker,
} from '@/features/demand/components';
import { useCategories, useSkills } from '@/features/providers/api';
import { toApiError } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMobile, formatMoney, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SiteDialog } from '@/routes/company/pages';

function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden /> {children}
    </Link>
  );
}

function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  return <Alert className="mb-4">{toApiError(error).message}</Alert>;
}

/** Reason-required confirmation (suspend, hold, cancel, decline). */
function ReasonDialog({
  open,
  onOpenChange,
  title,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      confirmLabel={confirmLabel}
      destructive
      onConfirm={async () => {
        await onConfirm(reason);
        setReason('');
        onOpenChange(false);
      }}
    >
      <Label htmlFor="reason">Reason</Label>
      <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
    </ConfirmDialog>
  );
}

/* =============================================================== companies */

const companyColumns: ColumnDef<CompanyView, unknown>[] = [
  {
    header: 'Company',
    accessorKey: 'legalName',
    cell: ({ row }) => (
      <div>
        <div className="font-medium">{row.original.legalName}</div>
        <div className="text-xs text-muted-foreground">
          {row.original.gstin ?? `PAN …${row.original.panLast4}`}
        </div>
      </div>
    ),
  },
  {
    header: 'City',
    id: 'city',
    cell: ({ row }) => `${row.original.billingAddress.city}, ${row.original.billingAddress.state}`,
  },
  { header: 'Sites', id: 'sites', cell: ({ row }) => row.original.activeSiteCount },
  { header: 'Registered', id: 'created', cell: ({ row }) => formatDate(row.original.createdAt) },
  { header: 'Status', id: 'st', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
];

export function CompaniesPage() {
  const navigate = useNavigate();
  const { page, pageSize, filters, setPage, setFilter } = useListParams(['status', 'q'] as const);
  const list = useAdminCompanies({ page, pageSize, status: filters.status, q: filters.q });
  return (
    <>
      <PageHeader
        title="Companies"
        description="Client companies, their verification and commercial terms."
      />
      <DataTable
        columns={companyColumns}
        data={list.data?.items}
        meta={list.data?.meta}
        isLoading={list.isLoading}
        onPageChange={setPage}
        getRowId={(r) => r.id}
        onRowClick={(r) => navigate(`/admin/companies/${r.id}`)}
        emptyTitle="No companies found"
        toolbar={
          <>
            <Input
              aria-label="Search"
              placeholder="Search name or GSTIN"
              className="sm:w-64"
              defaultValue={filters.q ?? ''}
              onKeyDown={(e) =>
                e.key === 'Enter' && setFilter('q', e.currentTarget.value.trim() || undefined)
              }
            />
            <Select
              aria-label="Status"
              className="sm:w-56"
              value={filters.status ?? ''}
              onChange={(e) => setFilter('status', e.target.value || undefined)}
            >
              <option value="">All statuses</option>
              {COMPANY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          </>
        }
      />
    </>
  );
}

function CommercialTermsForm({ company, canEdit }: { company: CompanyView; canEdit: boolean }) {
  const { terms } = useAdminCompanyActions(company.id);
  const form = useForm<CommercialTerms>({
    resolver: zodResolver(commercialTermsSchema),
    values: company.commercialTerms,
  });
  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={form.handleSubmit((v) =>
        terms.mutate(v, { onError: (e) => applyServerErrors(e, form.setError) }),
      )}
    >
      <FormField
        control={form.control}
        name="creditDays"
        label="Credit period (days)"
        render={(f, a) => (
          <Input
            {...a}
            type="number"
            disabled={!canEdit}
            value={f.value}
            onChange={(e) => f.onChange(e.target.valueAsNumber)}
          />
        )}
      />
      <FormField
        control={form.control}
        name="advancePct"
        label="Advance required (%)"
        render={(f, a) => (
          <Input
            {...a}
            type="number"
            disabled={!canEdit}
            value={f.value}
            onChange={(e) => f.onChange(e.target.valueAsNumber)}
          />
        )}
      />
      <FormField
        control={form.control}
        name="creditLimitPaise"
        label="Credit limit"
        hint="Empty means no limit"
        render={(f, a) => (
          <MoneyInput {...a} disabled={!canEdit} value={f.value} onChange={(v) => f.onChange(v)} />
        )}
      />
      <FormField
        control={form.control}
        name="offlinePaymentAllowed"
        label="Offline payments"
        render={(f, a) => (
          <label className="flex h-10 items-center gap-2 text-sm">
            <Checkbox
              id={a.id}
              disabled={!canEdit}
              checked={f.value}
              onChange={(e) => f.onChange(e.target.checked)}
            />{' '}
            Allowed
          </label>
        )}
      />
      {terms.isSuccess && !form.formState.isDirty && (
        <Alert tone="success" className="sm:col-span-2">
          Terms saved.
        </Alert>
      )}
      {canEdit && (
        <div className="sm:col-span-2">
          <Button type="submit" loading={terms.isPending}>
            Save terms
          </Button>
        </div>
      )}
    </form>
  );
}

export function CompanyDetailPage() {
  const { id = '' } = useParams();
  const company = useAdminCompany(id);
  const sites = useAdminCompanySites(id);
  const users = useAdminCompanyUsers(id);
  const actions = useAdminCompanyActions(id);
  const canActivate = useCan('company.activate');
  const [suspending, setSuspending] = useState(false);
  const [addingSite, setAddingSite] = useState(false);
  if (company.isLoading) return <Skeleton className="h-96 w-full" />;
  const c = company.data;
  if (!c) return <EmptyState title="Company not found" />;
  return (
    <>
      <BackLink to="/admin/companies">Companies</BackLink>
      <PageHeader
        title={c.legalName}
        description={`${c.billingAddress.city}, ${c.billingAddress.state}`}
        actions={
          <>
            <StatusBadge status={c.status} />
            {canActivate && c.status !== 'ACTIVE' && (
              <Button
                size="sm"
                loading={actions.activate.isPending}
                onClick={() => actions.activate.mutate()}
              >
                {c.status === 'SUSPENDED' ? 'Reinstate' : 'Verify & activate'}
              </Button>
            )}
            {canActivate && c.status === 'ACTIVE' && (
              <Button size="sm" variant="outline" onClick={() => setSuspending(true)}>
                Suspend
              </Button>
            )}
          </>
        }
      />
      <ErrorAlert error={actions.activate.error ?? actions.suspend.error} />
      {c.statusReason && (
        <Alert tone="warning" className="mb-4">
          {c.statusReason}
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>KYC details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Detail label="PAN">…{c.panLast4}</Detail>
            <Detail label="GSTIN">{c.gstin ?? 'Not registered'}</Detail>
            <Detail label="Industry">{c.industry ?? '—'}</Detail>
            <Detail label="Size">{c.size ?? '—'}</Detail>
            <div className="sm:col-span-2">
              <Detail label="Billing address">
                {[
                  c.billingAddress.line1,
                  c.billingAddress.line2,
                  c.billingAddress.city,
                  `${c.billingAddress.state} ${c.billingAddress.pincode}`,
                ]
                  .filter(Boolean)
                  .join(', ')}
              </Detail>
            </div>
            <Detail label="Primary contact">
              {c.primaryContact
                ? `${c.primaryContact.name}${c.primaryContact.mobile ? ` · ${formatMobile(c.primaryContact.mobile)}` : ''}`
                : '—'}
            </Detail>
            <Detail label="Verified">{c.activatedAt ? formatDateTime(c.activatedAt) : 'Not yet'}</Detail>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Commercial terms</CardTitle>
          </CardHeader>
          <CardContent>
            <CommercialTermsForm company={c} canEdit={canActivate} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Sites</CardTitle>
            {canActivate && (
              <Button size="sm" variant="outline" onClick={() => setAddingSite(true)}>
                <Plus aria-hidden /> Add site
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {sites.data?.length === 0 && <p className="text-sm text-muted-foreground">No sites yet.</p>}
            {sites.data?.map((s) => (
              <div key={s.id} className={cn('rounded-lg border p-3 text-sm', !s.isActive && 'opacity-60')}>
                <div className="font-medium">{s.name}</div>
                <div className="text-muted-foreground">
                  {s.address.city}, {s.address.state} · {s.contact.name} {formatMobile(s.contact.mobile)}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Team</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {users.data?.map((u) => (
              <div key={u.userId} className="flex justify-between rounded-lg border p-3 text-sm">
                <span>
                  {u.name} {u.mobile ? `· ${formatMobile(u.mobile)}` : ''}
                </span>
                <span className="text-muted-foreground">{humanize(u.roleCode.replace('COMPANY_', ''))}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <ReasonDialog
        open={suspending}
        onOpenChange={setSuspending}
        title={`Suspend ${c.legalName}?`}
        confirmLabel="Suspend"
        onConfirm={(r) => actions.suspend.mutateAsync(r)}
      />
      <SiteDialog
        open={addingSite}
        onOpenChange={setAddingSite}
        onSave={(input) => actions.addSite.mutateAsync(input)}
      />
    </>
  );
}

/* =============================================================== enquiries */

const enquiryColumns: ColumnDef<EnquiryView, unknown>[] = [
  {
    header: 'Enquiry',
    accessorKey: 'enquiryNo',
    cell: ({ row }) => (
      <div>
        <div className="font-medium">{row.original.enquiryNo}</div>
        <div className="text-xs text-muted-foreground">{humanize(row.original.source)}</div>
      </div>
    ),
  },
  {
    header: 'Company',
    id: 'co',
    cell: ({ row }) => row.original.companyName || row.original.lead?.companyName || '—',
  },
  { header: 'Service', id: 'svc', cell: ({ row }) => row.original.categoryName },
  { header: 'People', id: 'hc', cell: ({ row }) => row.original.lines.reduce((a, l) => a + l.headcount, 0) },
  {
    header: 'Assigned',
    id: 'as',
    cell: ({ row }) =>
      row.original.assignedTo?.name ?? <span className="text-muted-foreground">Unassigned</span>,
  },
  { header: 'Received', id: 'rc', cell: ({ row }) => formatDateTime(row.original.createdAt) },
  { header: 'Status', id: 'st', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
];

export function EnquiriesInboxPage() {
  const navigate = useNavigate();
  const { page, pageSize, filters, setPage, setFilter } = useListParams([
    'status',
    'source',
    'assignedTo',
    'q',
  ] as const);
  const list = useAdminEnquiries({ page, pageSize, ...filters });
  return (
    <>
      <PageHeader title="Enquiries" description="Incoming demand from companies and public leads." />
      <DataTable
        columns={enquiryColumns}
        data={list.data?.items}
        meta={list.data?.meta}
        isLoading={list.isLoading}
        onPageChange={setPage}
        getRowId={(r) => r.id}
        onRowClick={(r) => navigate(`/admin/enquiries/${r.id}`)}
        emptyTitle="No enquiries"
        toolbar={
          <>
            <Input
              aria-label="Search"
              placeholder="Search number, company…"
              className="sm:w-56"
              defaultValue={filters.q ?? ''}
              onKeyDown={(e) =>
                e.key === 'Enter' && setFilter('q', e.currentTarget.value.trim() || undefined)
              }
            />
            <Select
              aria-label="Status"
              className="sm:w-40"
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
            <Select
              aria-label="Source"
              className="sm:w-40"
              value={filters.source ?? ''}
              onChange={(e) => setFilter('source', e.target.value || undefined)}
            >
              <option value="">All sources</option>
              {ENQUIRY_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Assigned"
              className="sm:w-40"
              value={filters.assignedTo ?? ''}
              onChange={(e) => setFilter('assignedTo', e.target.value || undefined)}
            >
              <option value="">Anyone</option>
              <option value="me">Assigned to me</option>
              <option value="none">Unassigned</option>
            </Select>
          </>
        }
      />
    </>
  );
}

function ConvertLeadDialog({
  enquiry,
  open,
  onOpenChange,
}: {
  enquiry: EnquiryView;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { convert } = useAdminEnquiryActions(enquiry.id);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [search, setSearch] = useState(enquiry.lead?.companyName ?? '');
  const existing = useAdminCompanies({ page: 1, pageSize: 10, q: search || undefined });
  const [companyId, setCompanyId] = useState('');
  const form = useForm<{
    newCompany: { legalName: string; pan: string; gstin?: string; billingAddress: Record<string, string> };
  }>({
    defaultValues: {
      newCompany: {
        legalName: enquiry.lead?.companyName ?? '',
        pan: '',
        billingAddress: {
          line1: '',
          city: enquiry.lead?.city ?? '',
          state: '',
          stateCode: '',
          pincode: '',
          country: 'IN',
        },
      },
    },
  });
  const error = convert.error ? toApiError(convert.error) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Convert lead to a company</DialogTitle>
        </DialogHeader>
        <div className="mb-2 flex gap-2" role="tablist">
          {(['new', 'existing'] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              role="tab"
              aria-selected={mode === m}
              variant={mode === m ? 'default' : 'outline'}
              onClick={() => setMode(m)}
            >
              {m === 'new' ? 'New company' : 'Existing company'}
            </Button>
          ))}
        </div>
        {mode === 'existing' ? (
          <div className="grid gap-3">
            <Input
              aria-label="Search companies"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search companies"
            />
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {existing.data?.items.map((c) => (
                <label key={c.id} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
                  <input
                    type="radio"
                    name="company"
                    checked={companyId === c.id}
                    onChange={() => setCompanyId(c.id)}
                  />
                  {c.legalName} <span className="text-muted-foreground">· {c.billingAddress.city}</span>
                </label>
              ))}
            </div>
            {error && <Alert>{error.message}</Alert>}
            <DialogFooter>
              <Button
                disabled={!companyId}
                loading={convert.isPending}
                onClick={() => convert.mutate({ companyId }, { onSuccess: () => onOpenChange(false) })}
              >
                Link to company
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            noValidate
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={form.handleSubmit((v) =>
              convert.mutate(
                {
                  newCompany: {
                    ...v.newCompany,
                    ...(v.newCompany.gstin ? {} : { gstin: undefined }),
                  } as never,
                },
                { onSuccess: () => onOpenChange(false), onError: (e) => applyServerErrors(e, form.setError) },
              ),
            )}
          >
            <p className="text-sm text-muted-foreground sm:col-span-2">
              {enquiry.lead?.name} ({enquiry.lead?.mobile ? formatMobile(enquiry.lead.mobile) : ''}) becomes
              the Company Admin and signs in with OTP.
            </p>
            <FormField
              control={form.control}
              name="newCompany.legalName"
              label="Legal name"
              required
              className="sm:col-span-2"
              render={(f, a) => <Input {...a} {...f} />}
            />
            <FormField
              control={form.control}
              name="newCompany.pan"
              label="PAN"
              required
              render={(f, a) => (
                <Input {...a} {...f} onChange={(e) => f.onChange(e.target.value.toUpperCase())} />
              )}
            />
            <FormField
              control={form.control}
              name="newCompany.gstin"
              label="GSTIN"
              render={(f, a) => (
                <Input
                  {...a}
                  value={f.value ?? ''}
                  onChange={(e) => f.onChange(e.target.value.toUpperCase() || undefined)}
                />
              )}
            />
            <GstAddressFields
              control={form.control}
              prefix="newCompany.billingAddress"
              label="Billing address"
              setValue={(n, v) => form.setValue(n, v)}
            />
            {error && !(error.status === 400 && error.details.length > 0) && (
              <Alert className="sm:col-span-2">{error.message}</Alert>
            )}
            <DialogFooter className="sm:col-span-2">
              <Button type="submit" loading={convert.isPending}>
                Create company
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AdminEnquiryPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const enquiry = useAdminEnquiry(id);
  const quotations = useAdminQuotations({ enquiryId: id, page: 1, pageSize: 50 });
  const actions = useAdminEnquiryActions(id);
  const canQuote = useCan('quotation.manage');
  const [note, setNote] = useState('');
  const [declining, setDeclining] = useState<'REJECTED' | 'CANCELLED' | null>(null);
  const [converting, setConverting] = useState(false);
  if (enquiry.isLoading) return <Skeleton className="h-96 w-full" />;
  const e = enquiry.data;
  if (!e) return <EmptyState title="Enquiry not found" />;
  const open = e.status === 'NEW' || e.status === 'IN_REVIEW';
  const hasLatest = quotations.data?.items.some((q) => q.isLatest);
  return (
    <>
      <BackLink to="/admin/enquiries">Enquiries</BackLink>
      <PageHeader
        title={e.enquiryNo}
        description={`${e.companyName || e.lead?.companyName || ''} · ${e.categoryName}`}
        actions={
          <>
            <StatusBadge status={e.status} />
            {e.assignedTo?.id !== user?.id && (
              <Button size="sm" variant="outline" onClick={() => user && actions.assign.mutate(user.id)}>
                Assign to me
              </Button>
            )}
            {open && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setDeclining('REJECTED')}>
                  Decline
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeclining('CANCELLED')}>
                  Cancel
                </Button>
              </>
            )}
          </>
        }
      />
      <ErrorAlert error={actions.assign.error ?? actions.status.error} />
      {e.source === 'PUBLIC_LEAD' && !e.companyId && (
        <Alert tone="warning" className="mb-4 flex flex-wrap items-center justify-between gap-2">
          This is a public lead. Convert it into a company account before quoting.
          <Button size="sm" onClick={() => setConverting(true)}>
            Convert lead
          </Button>
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <Card>
            <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
              {e.lead && (
                <Detail label="Lead">
                  {e.lead.name} · {formatMobile(e.lead.mobile)}
                  {e.lead.email ? ` · ${e.lead.email}` : ''} · {e.lead.city}
                </Detail>
              )}
              <Detail label="Site">{e.siteName ?? '—'}</Detail>
              <Detail label="Schedule">{formatSchedule(e.schedule)}</Detail>
              <Detail label="Shift">{formatShift(e.schedule.shift)}</Detail>
              <Detail label="People">
                <ul>
                  {e.lines.map((l) => (
                    <li key={l.skillId}>
                      {l.headcount} × {l.skillName}
                      {l.minExperienceYears ? ` (${l.minExperienceYears}+ yrs)` : ''}
                    </li>
                  ))}
                </ul>
              </Detail>
              <Detail label="Budget">{e.budgetPaise === undefined ? '—' : formatMoney(e.budgetPaise)}</Detail>
              <div className="sm:col-span-2">
                <Detail label="Description">
                  <span className="whitespace-pre-line">{e.description}</span>
                </Detail>
              </div>
              {e.statusReason && <Detail label="Status note">{e.statusReason}</Detail>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Quotations</CardTitle>
              {canQuote && e.companyId && open && !hasLatest && (
                <Button size="sm" onClick={() => navigate(`/admin/quotations/new?enquiryId=${e.id}`)}>
                  <Plus aria-hidden /> Create quotation
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-2">
              {quotations.data?.items.length === 0 && (
                <p className="text-sm text-muted-foreground">No quotation yet.</p>
              )}
              {quotations.data?.items.map((q) => (
                <Link
                  key={q.id}
                  to={`/admin/quotations/${q.id}`}
                  className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent"
                >
                  <span>
                    <span className="font-medium">
                      {q.quotationNo} v{q.version}
                    </span>
                    <span className="ml-2 tabular text-sm text-muted-foreground">
                      {formatMoney(q.totalPaise)}
                    </span>
                  </span>
                  <StatusBadge status={q.status} />
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Internal notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">Assigned to: {e.assignedTo?.name ?? 'nobody'}</p>
            {e.notes?.map((n, i) => (
              <div key={i} className="rounded-lg bg-muted p-3 text-sm">
                <p className="whitespace-pre-line">{n.text}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {n.byName} · {formatDateTime(n.at)}
                </p>
              </div>
            ))}
            <form
              className="space-y-2"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (note.trim()) actions.note.mutate(note.trim(), { onSuccess: () => setNote('') });
              }}
            >
              <Label htmlFor="note">Add a note</Label>
              <Textarea id="note" rows={3} value={note} onChange={(ev) => setNote(ev.target.value)} />
              <Button type="submit" size="sm" loading={actions.note.isPending}>
                Add note
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
      <ReasonDialog
        open={!!declining}
        onOpenChange={(o) => !o && setDeclining(null)}
        title={declining === 'REJECTED' ? 'Decline this enquiry?' : 'Cancel this enquiry?'}
        confirmLabel={declining === 'REJECTED' ? 'Decline' : 'Cancel enquiry'}
        onConfirm={(reason) => actions.status.mutateAsync({ status: declining ?? 'CANCELLED', reason })}
      />
      {converting && <ConvertLeadDialog enquiry={e} open={converting} onOpenChange={setConverting} />}
    </>
  );
}

/* =============================================================== quotation builder */

const GST_SLABS = [0, 500, 1200, 1800, 2800];

function addDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function defaultsFromEnquiry(e: EnquiryView, validUntil: string): QuotationInput {
  const end = e.schedule.endDate ?? (e.schedule.durationDays ? undefined : e.schedule.startDate);
  return {
    siteId: e.siteId ?? '',
    lines: e.lines.map((l) => ({
      skillId: l.skillId,
      description: l.skillName ?? 'Service',
      headcount: l.headcount,
      unit: 'DAY',
      ratePaise: 0,
      quantity: 26,
    })),
    discountPaise: 0,
    schedule: {
      startDate: e.schedule.startDate,
      endDate: end ?? e.schedule.startDate,
      weekdays: e.schedule.weekdays,
      shift: e.schedule.shift,
    },
    paymentTerms: { advancePct: 0, milestones: [] },
    terms: '',
    validUntil,
  };
}

function toInput(q: QuotationView): QuotationInput {
  return {
    siteId: q.siteId,
    lines: q.lines.map((l) => ({
      skillId: l.skillId,
      description: l.description,
      headcount: l.headcount,
      unit: l.unit,
      ratePaise: l.ratePaise,
      quantity: l.quantity,
      ...(l.payRatePaise !== undefined ? { payRatePaise: l.payRatePaise } : {}),
      sacCode: l.sacCode,
      gstRateBp: l.gstRateBp,
    })),
    discountPaise: q.discountPaise,
    schedule: q.schedule,
    paymentTerms: q.paymentTerms,
    terms: q.terms,
    validUntil: q.validUntil,
  };
}

function LiveTotals({
  control,
  supplier,
  place,
  defaultRate,
}: {
  control: ReturnType<typeof useForm<QuotationInput>>['control'];
  supplier: string;
  place: string;
  defaultRate: number;
}) {
  const lines = useWatch({ control, name: 'lines' });
  const discount = useWatch({ control, name: 'discountPaise' }) ?? 0;
  const result = useMemo(() => {
    try {
      return computeTaxTotals({
        lines: (lines ?? []).map((l) => ({
          ratePaise: Number.isInteger(l.ratePaise) ? l.ratePaise : 0,
          headcount: Number.isInteger(l.headcount) && l.headcount > 0 ? l.headcount : 1,
          quantity: Number.isInteger(l.quantity) && l.quantity > 0 ? l.quantity : 1,
          gstRateBp: l.gstRateBp ?? defaultRate,
        })),
        discountPaise: discount,
        supplierStateCode: supplier,
        placeOfSupplyStateCode: place,
      });
    } catch (e) {
      return e instanceof TaxInputError ? e.message : 'Check the amounts';
    }
  }, [lines, discount, supplier, place, defaultRate]);
  if (typeof result === 'string') return <Alert>{result}</Alert>;
  const rows: Array<[string, number, boolean?]> = [
    ['Subtotal', result.subtotalPaise],
    ['Discount', -result.discountPaise],
    ['Taxable', result.taxablePaise],
    ...(result.type === 'INTRA'
      ? ([
          ['CGST', result.cgstPaise],
          ['SGST', result.sgstPaise],
        ] as Array<[string, number]>)
      : ([['IGST', result.igstPaise]] as Array<[string, number]>)),
    ['Total', result.totalPaise, true],
  ];
  return (
    <dl className="space-y-1 text-sm" aria-live="polite" data-testid="live-totals">
      {rows.map(([label, v, strong]) => (
        <div
          key={label}
          className={cn('flex justify-between', strong && 'border-t pt-2 text-base font-semibold')}
        >
          <dt>{label}</dt>
          <dd className="tabular">{v < 0 ? `− ${formatMoney(-v)}` : formatMoney(v)}</dd>
        </div>
      ))}
      <p className="pt-1 text-xs text-muted-foreground">
        {result.type === 'INTRA' ? 'Intra-state: CGST + SGST' : 'Inter-state: IGST'}
      </p>
    </dl>
  );
}

function QuotationEditor({
  initial,
  companyId,
  readOnly,
  submitLabel,
  pending,
  error,
  onSubmit,
}: {
  initial: QuotationInput;
  companyId: string;
  readOnly: boolean;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (v: QuotationInput, setError: (e: unknown) => void) => void;
}) {
  const skills = useSkills();
  const sites = useAdminCompanySites(companyId);
  const ctx = useQuotationTaxContext(companyId);
  const form = useForm<QuotationInput>({
    resolver: zodResolver(quotationInputSchema) as unknown as Resolver<QuotationInput>,
    values: initial,
  });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const milestones = useFieldArray({ control: form.control, name: 'paymentTerms.milestones' });
  const apiError = error ? toApiError(error) : null;
  const num = (v: number) => (Number.isNaN(v) ? undefined : v);
  return (
    <form
      noValidate
      className="grid gap-4 lg:grid-cols-[1fr_18rem]"
      onSubmit={form.handleSubmit((v) => onSubmit(v, (e) => applyServerErrors(e, form.setError)))}
    >
      <fieldset disabled={readOnly} className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {lines.fields.map((field, i) => (
              <div key={field.id} className="grid gap-3 rounded-xl border p-3 sm:grid-cols-6">
                <FormField
                  control={form.control}
                  name={`lines.${i}.skillId`}
                  label="Skill"
                  className="sm:col-span-2"
                  render={(f, a) => (
                    <Select {...a} value={f.value} onChange={f.onChange}>
                      <option value="" disabled>
                        Choose
                      </option>
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
                  name={`lines.${i}.description`}
                  label="Description"
                  className="sm:col-span-4"
                  render={(f, a) => <Input {...a} {...f} />}
                />
                <FormField
                  control={form.control}
                  name={`lines.${i}.headcount`}
                  label="People"
                  render={(f, a) => (
                    <Input
                      {...a}
                      type="number"
                      min={1}
                      value={f.value ?? ''}
                      onChange={(e) => f.onChange(num(e.target.valueAsNumber))}
                    />
                  )}
                />
                <FormField
                  control={form.control}
                  name={`lines.${i}.unit`}
                  label="Unit"
                  render={(f, a) => (
                    <Select {...a} value={f.value} onChange={f.onChange}>
                      {BILL_UNITS.map((u) => (
                        <option key={u} value={u}>
                          per {UNIT_LABELS[u]}
                        </option>
                      ))}
                    </Select>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`lines.${i}.quantity`}
                  label="Units / person"
                  render={(f, a) => (
                    <Input
                      {...a}
                      type="number"
                      min={1}
                      value={f.value ?? ''}
                      onChange={(e) => f.onChange(num(e.target.valueAsNumber))}
                    />
                  )}
                />
                <FormField
                  control={form.control}
                  name={`lines.${i}.ratePaise`}
                  label="Bill rate"
                  render={(f, a) => (
                    <MoneyInput {...a} value={f.value} onChange={(v) => f.onChange(v ?? 0)} />
                  )}
                />
                <FormField
                  control={form.control}
                  name={`lines.${i}.payRatePaise`}
                  label="Pay rate (internal)"
                  render={(f, a) => (
                    <MoneyInput {...a} value={f.value ?? null} onChange={(v) => f.onChange(v ?? undefined)} />
                  )}
                />
                <FormField
                  control={form.control}
                  name={`lines.${i}.gstRateBp`}
                  label="GST"
                  render={(f, a) => (
                    <Select
                      {...a}
                      value={String(f.value ?? ctx.data?.defaultGstRateBp ?? 1800)}
                      onChange={(e) => f.onChange(Number(e.target.value))}
                    >
                      {GST_SLABS.map((bp) => (
                        <option key={bp} value={bp}>
                          {bp / 100}%
                        </option>
                      ))}
                    </Select>
                  )}
                />
                <div className="flex items-end justify-end sm:col-span-6">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={lines.fields.length === 1}
                    onClick={() => lines.remove(i)}
                  >
                    <Trash2 aria-hidden /> Remove line
                  </Button>
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                lines.append({
                  skillId: '',
                  description: '',
                  headcount: 1,
                  unit: 'DAY',
                  ratePaise: 0,
                  quantity: 1,
                })
              }
            >
              <Plus aria-hidden /> Add line
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Schedule and site</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="siteId"
              label="Site"
              className="sm:col-span-2"
              render={(f, a) => (
                <Select {...a} value={f.value} onChange={f.onChange}>
                  <option value="" disabled>
                    Choose a site
                  </option>
                  {sites.data
                    ?.filter((s) => s.isActive)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.address.city}
                      </option>
                    ))}
                </Select>
              )}
            />
            <FormField
              control={form.control}
              name="schedule.startDate"
              label="Start date"
              render={(f, a) => <Input {...a} type="date" {...f} />}
            />
            <FormField
              control={form.control}
              name="schedule.endDate"
              label="End date"
              render={(f, a) => <Input {...a} type="date" {...f} />}
            />
            <FormField
              control={form.control}
              name="schedule.weekdays"
              label="Working days"
              className="sm:col-span-2"
              render={(f, a) => <WeekdayPicker id={a.id} value={f.value ?? []} onChange={f.onChange} />}
            />
            <FormField
              control={form.control}
              name="schedule.shift.startMin"
              label="Shift starts"
              render={(f, a) => <TimeInput {...a} value={f.value} onChange={f.onChange} />}
            />
            <FormField
              control={form.control}
              name="schedule.shift.endMin"
              label="Shift ends"
              render={(f, a) => <TimeInput {...a} value={f.value} onChange={f.onChange} />}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment and terms</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="paymentTerms.advancePct"
              label="Advance (%)"
              render={(f, a) => (
                <Input
                  {...a}
                  type="number"
                  min={0}
                  max={100}
                  value={f.value ?? 0}
                  onChange={(e) => f.onChange(num(e.target.valueAsNumber) ?? 0)}
                />
              )}
            />
            <FormField
              control={form.control}
              name="validUntil"
              label="Valid until"
              render={(f, a) => <Input {...a} type="date" {...f} />}
            />
            <div className="space-y-2 sm:col-span-2">
              <Label>Milestones</Label>
              {milestones.fields.map((m, i) => (
                <div key={m.id} className="grid grid-cols-[1fr_5rem_9rem_auto] items-end gap-2">
                  <FormField
                    control={form.control}
                    name={`paymentTerms.milestones.${i}.label`}
                    label="Label"
                    render={(f, a) => <Input {...a} {...f} />}
                  />
                  <FormField
                    control={form.control}
                    name={`paymentTerms.milestones.${i}.pct`}
                    label="%"
                    render={(f, a) => (
                      <Input
                        {...a}
                        type="number"
                        value={f.value ?? ''}
                        onChange={(e) => f.onChange(num(e.target.valueAsNumber))}
                      />
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`paymentTerms.milestones.${i}.due`}
                    label="Due"
                    render={(f, a) => (
                      <Select {...a} value={f.value} onChange={f.onChange}>
                        {MILESTONE_DUE.filter((d) => d !== 'DATE').map((d) => (
                          <option key={d} value={d}>
                            {humanize(d)}
                          </option>
                        ))}
                      </Select>
                    )}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove milestone"
                    onClick={() => milestones.remove(i)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              ))}
              {form.formState.errors.paymentTerms?.milestones?.root?.message && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {form.formState.errors.paymentTerms.milestones.root.message}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => milestones.append({ label: '', pct: 50, due: 'ON_COMPLETION' })}
              >
                <Plus aria-hidden /> Add milestone
              </Button>
            </div>
            <FormField
              control={form.control}
              name="terms"
              label="Terms and conditions"
              className="sm:col-span-2"
              render={(f, a) => <Textarea {...a} rows={4} {...f} value={f.value ?? ''} />}
            />
          </CardContent>
        </Card>
      </fieldset>

      <div className="space-y-4">
        <Card className="lg:sticky lg:top-4">
          <CardHeader>
            <CardTitle>Totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <FormField
              control={form.control}
              name="discountPaise"
              label="Discount"
              render={(f, a) => (
                <MoneyInput
                  {...a}
                  disabled={readOnly}
                  value={f.value ?? 0}
                  onChange={(v) => f.onChange(v ?? 0)}
                />
              )}
            />
            {ctx.data ? (
              <LiveTotals
                control={form.control}
                supplier={ctx.data.supplierStateCode}
                place={ctx.data.placeOfSupplyStateCode}
                defaultRate={ctx.data.defaultGstRateBp}
              />
            ) : (
              <Skeleton className="h-32 w-full" />
            )}
            {apiError && !(apiError.status === 400 && apiError.details.length > 0) && (
              <Alert>{apiError.message}</Alert>
            )}
            {Object.keys(form.formState.errors).length > 0 && <Alert>Check the highlighted fields.</Alert>}
            {!readOnly && (
              <Button type="submit" className="w-full" loading={pending}>
                {submitLabel}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </form>
  );
}

export function NewQuotationPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const enquiryId = params.get('enquiryId') ?? '';
  const enquiry = useAdminEnquiry(enquiryId);
  const ctx = useQuotationTaxContext(enquiry.data?.companyId);
  const { createQuotation } = useAdminEnquiryActions(enquiryId);
  if (enquiry.isLoading || (enquiry.data?.companyId && ctx.isLoading))
    return <Skeleton className="h-96 w-full" />;
  const e = enquiry.data;
  if (!e?.companyId)
    return (
      <EmptyState
        title="This enquiry cannot be quoted yet"
        description="Convert the lead into a company first."
      />
    );
  return (
    <>
      <BackLink to={`/admin/enquiries/${e.id}`}>{e.enquiryNo}</BackLink>
      <PageHeader title="New quotation" description={`${e.companyName} · ${e.categoryName}`} />
      <QuotationEditor
        initial={defaultsFromEnquiry(e, ctx.data?.defaultValidUntil ?? addDaysIso(15))}
        companyId={e.companyId}
        readOnly={false}
        submitLabel="Save draft"
        pending={createQuotation.isPending}
        error={createQuotation.error}
        onSubmit={(v, setError) =>
          createQuotation.mutate(v, {
            onSuccess: (q) => navigate(`/admin/quotations/${q.id}`, { replace: true }),
            onError: setError,
          })
        }
      />
    </>
  );
}

export function QuotationBuilderPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const quotation = useAdminQuotation(id);
  const actions = useAdminQuotationActions(id);
  const [sending, setSending] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const initial = useMemo(() => (quotation.data ? toInput(quotation.data) : null), [quotation.data]);
  if (quotation.isLoading || !initial) return <Skeleton className="h-96 w-full" />;
  const q = quotation.data as QuotationView;
  const draft = q.status === 'DRAFT';
  return (
    <>
      <BackLink to={`/admin/enquiries/${q.enquiryId}`}>{q.enquiryNo}</BackLink>
      <PageHeader
        title={`${q.quotationNo} · v${q.version}`}
        description={`${q.companyName} · ${q.siteName}`}
        actions={
          <>
            <StatusBadge status={q.status} />
            {!q.isLatest && <StatusBadge status="SUPERSEDED" label="Older version" />}
            <Button
              size="sm"
              variant="outline"
              loading={pdfBusy}
              onClick={async () => {
                setPdfBusy(true);
                try {
                  await openPdf(`/admin/quotations/${q.id}/pdf-url`);
                } finally {
                  setPdfBusy(false);
                }
              }}
            >
              <FileDown aria-hidden /> {draft ? 'Preview PDF' : 'PDF'}
            </Button>
            {draft && (
              <Button size="sm" onClick={() => setSending(true)}>
                <Send aria-hidden /> Send to company
              </Button>
            )}
            {q.isLatest && ['SENT', 'REJECTED', 'EXPIRED'].includes(q.status) && (
              <Button
                size="sm"
                variant="outline"
                loading={actions.revise.isPending}
                onClick={() =>
                  actions.revise.mutate(undefined, {
                    onSuccess: (n) => navigate(`/admin/quotations/${n.id}`),
                  })
                }
              >
                Revise (new version)
              </Button>
            )}
          </>
        }
      />
      <ErrorAlert error={actions.send.error ?? actions.revise.error} />
      {q.decision && (
        <Alert tone={q.status === 'ACCEPTED' ? 'success' : 'warning'} className="mb-4">
          {humanize(q.status)} by {q.decision.byName} on {formatDateTime(q.decision.at)}
          {q.decision.reason ? `: ${q.decision.reason}` : ''}
          {q.jobId && (
            <>
              {' '}
              ·{' '}
              <Link className="font-semibold underline" to={`/admin/jobs/${q.jobId}`}>
                Open job
              </Link>
            </>
          )}
        </Alert>
      )}
      {draft ? (
        <QuotationEditor
          initial={initial}
          companyId={q.companyId}
          readOnly={false}
          submitLabel="Save changes"
          pending={actions.update.isPending}
          error={actions.update.error}
          onSubmit={(v, setError) => actions.update.mutate({ input: v, rev: q.rev }, { onError: setError })}
        />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <QuotationDocument q={q} showPayRate />
          </CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={sending}
        onOpenChange={setSending}
        title="Send this quotation?"
        description={`The company admins are notified and can accept ${formatMoney(q.totalPaise)} until ${formatDate(q.validUntil)}. Sent quotations can only be changed by revising them.`}
        confirmLabel="Send"
        onConfirm={async () => {
          await actions.send.mutateAsync();
          setSending(false);
        }}
      />
    </>
  );
}

/* =============================================================== jobs */

const jobColumns: ColumnDef<JobView, unknown>[] = [
  {
    header: 'Job',
    accessorKey: 'jobNo',
    cell: ({ row }) => (
      <div>
        <div className="font-medium">{row.original.jobNo}</div>
        <div className="max-w-xs truncate text-xs text-muted-foreground">{row.original.title}</div>
      </div>
    ),
  },
  { header: 'Company', id: 'co', cell: ({ row }) => row.original.companyName },
  {
    header: 'Site',
    id: 'site',
    cell: ({ row }) => `${row.original.siteName}${row.original.siteCity ? `, ${row.original.siteCity}` : ''}`,
  },
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

export function AdminJobsPage() {
  const navigate = useNavigate();
  const canManage = useCan('job.manage');
  const { page, pageSize, filters, setPage, setFilter } = useListParams([
    'status',
    'q',
    'companyId',
  ] as const);
  const list = useAdminJobs({ page, pageSize, ...filters });
  return (
    <>
      <PageHeader
        title="Jobs"
        description="Staffing requests from accepted quotations or created manually."
        actions={
          canManage && (
            <Button onClick={() => navigate('/admin/jobs/new')}>
              <Plus aria-hidden /> New job
            </Button>
          )
        }
      />
      <DataTable
        columns={jobColumns}
        data={list.data?.items}
        meta={list.data?.meta}
        isLoading={list.isLoading}
        onPageChange={setPage}
        getRowId={(r) => r.id}
        onRowClick={(r) => navigate(`/admin/jobs/${r.id}`)}
        emptyTitle="No jobs"
        toolbar={
          <>
            <Input
              aria-label="Search"
              placeholder="Job number or title"
              className="sm:w-56"
              defaultValue={filters.q ?? ''}
              onKeyDown={(e) =>
                e.key === 'Enter' && setFilter('q', e.currentTarget.value.trim() || undefined)
              }
            />
            <Select
              aria-label="Status"
              className="sm:w-48"
              value={filters.status ?? ''}
              onChange={(e) => setFilter('status', e.target.value || undefined)}
            >
              <option value="">All statuses</option>
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          </>
        }
      />
    </>
  );
}

export function NewJobPage() {
  const navigate = useNavigate();
  const create = useAdminCreateJob();
  const companies = useAdminCompanies({ page: 1, pageSize: 100, status: 'ACTIVE' });
  const categories = useCategories();
  const skills = useSkills();
  const form = useForm<JobCreateInput>({
    resolver: zodResolver(jobCreateSchema) as unknown as Resolver<JobCreateInput>,
    defaultValues: {
      companyId: '',
      siteId: '',
      categoryId: '',
      title: '',
      schedule: {
        startDate: '',
        endDate: '',
        weekdays: [1, 2, 3, 4, 5, 6],
        excludedDates: [],
        timezone: 'Asia/Kolkata',
      },
      positions: [
        {
          skillId: '',
          title: '',
          shift: { startMin: 540, endMin: 1080 },
          required: 1,
          billRatePaise: 0,
          billUnit: 'DAY',
        },
      ],
      billingBasis: 'ATTENDANCE',
    },
  });
  const companyId = useWatch({ control: form.control, name: 'companyId' });
  const sites = useAdminCompanySites(companyId || undefined);
  const positions = useFieldArray({ control: form.control, name: 'positions' });
  const num = (v: number) => (Number.isNaN(v) ? undefined : v);
  const apiError = create.error ? toApiError(create.error) : null;
  return (
    <>
      <BackLink to="/admin/jobs">Jobs</BackLink>
      <PageHeader
        title="New job"
        description="Manual jobs are created as drafts for verified companies; open them when ready."
      />
      <form
        noValidate
        className="space-y-4"
        onSubmit={form.handleSubmit((v) =>
          create.mutate(v, {
            onSuccess: (j) => navigate(`/admin/jobs/${j.id}`, { replace: true }),
            onError: (e) => applyServerErrors(e, form.setError),
          }),
        )}
      >
        <Card>
          <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="companyId"
              label="Company"
              required
              render={(f, a) => (
                <Select
                  {...a}
                  value={f.value}
                  onChange={(e) => {
                    f.onChange(e.target.value);
                    form.setValue('siteId', '');
                  }}
                >
                  <option value="" disabled>
                    Choose a verified company
                  </option>
                  {companies.data?.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.legalName}
                    </option>
                  ))}
                </Select>
              )}
            />
            <FormField
              control={form.control}
              name="siteId"
              label="Site"
              required
              render={(f, a) => (
                <Select {...a} value={f.value} onChange={f.onChange} disabled={!companyId}>
                  <option value="" disabled>
                    Choose a site
                  </option>
                  {sites.data
                    ?.filter((s) => s.isActive)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </Select>
              )}
            />
            <FormField
              control={form.control}
              name="categoryId"
              label="Service"
              required
              render={(f, a) => (
                <Select {...a} value={f.value} onChange={f.onChange}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {categories.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            />
            <FormField
              control={form.control}
              name="title"
              label="Title"
              required
              render={(f, a) => <Input {...a} {...f} />}
            />
            <FormField
              control={form.control}
              name="schedule.startDate"
              label="Start date"
              required
              render={(f, a) => <Input {...a} type="date" {...f} />}
            />
            <FormField
              control={form.control}
              name="schedule.endDate"
              label="End date"
              required
              render={(f, a) => <Input {...a} type="date" {...f} />}
            />
            <FormField
              control={form.control}
              name="schedule.weekdays"
              label="Working days"
              className="sm:col-span-2"
              render={(f, a) => <WeekdayPicker id={a.id} value={f.value ?? []} onChange={f.onChange} />}
            />
            <FormField
              control={form.control}
              name="instructions"
              label="Instructions for providers"
              className="sm:col-span-2"
              render={(f, a) => (
                <Textarea
                  {...a}
                  rows={3}
                  value={f.value ?? ''}
                  onChange={(e) => f.onChange(e.target.value || undefined)}
                />
              )}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Positions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {positions.fields.map((p, i) => (
              <div key={p.id} className="grid gap-3 rounded-xl border p-3 sm:grid-cols-4">
                <FormField
                  control={form.control}
                  name={`positions.${i}.skillId`}
                  label="Skill"
                  render={(f, a) => (
                    <Select {...a} value={f.value} onChange={f.onChange}>
                      <option value="" disabled>
                        Choose
                      </option>
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
                  name={`positions.${i}.title`}
                  label="Title"
                  render={(f, a) => <Input {...a} {...f} />}
                />
                <FormField
                  control={form.control}
                  name={`positions.${i}.required`}
                  label="People"
                  render={(f, a) => (
                    <Input
                      {...a}
                      type="number"
                      min={1}
                      value={f.value ?? ''}
                      onChange={(e) => f.onChange(num(e.target.valueAsNumber))}
                    />
                  )}
                />
                <FormField
                  control={form.control}
                  name={`positions.${i}.minExperienceYears`}
                  label="Min. experience"
                  render={(f, a) => (
                    <Input
                      {...a}
                      type="number"
                      min={0}
                      value={f.value ?? 0}
                      onChange={(e) => f.onChange(num(e.target.valueAsNumber) ?? 0)}
                    />
                  )}
                />
                <FormField
                  control={form.control}
                  name={`positions.${i}.shift.startMin`}
                  label="Shift starts"
                  render={(f, a) => <TimeInput {...a} value={f.value} onChange={f.onChange} />}
                />
                <FormField
                  control={form.control}
                  name={`positions.${i}.shift.endMin`}
                  label="Shift ends"
                  render={(f, a) => <TimeInput {...a} value={f.value} onChange={f.onChange} />}
                />
                <FormField
                  control={form.control}
                  name={`positions.${i}.billRatePaise`}
                  label="Bill rate"
                  render={(f, a) => (
                    <MoneyInput {...a} value={f.value} onChange={(v) => f.onChange(v ?? 0)} />
                  )}
                />
                <FormField
                  control={form.control}
                  name={`positions.${i}.billUnit`}
                  label="Per"
                  render={(f, a) => (
                    <Select {...a} value={f.value} onChange={f.onChange}>
                      {BILL_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {UNIT_LABELS[u]}
                        </option>
                      ))}
                    </Select>
                  )}
                />
                <div className="flex justify-end sm:col-span-4">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={positions.fields.length === 1}
                    onClick={() => positions.remove(i)}
                  >
                    <Trash2 aria-hidden /> Remove
                  </Button>
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                positions.append({
                  skillId: '',
                  title: '',
                  shift: { startMin: 540, endMin: 1080 },
                  required: 1,
                  billRatePaise: 0,
                  billUnit: 'DAY',
                })
              }
            >
              <Plus aria-hidden /> Add position
            </Button>
          </CardContent>
        </Card>
        {apiError && !(apiError.status === 400 && apiError.details.length > 0) && (
          <Alert>{apiError.message}</Alert>
        )}
        <Button type="submit" loading={create.isPending}>
          Create draft job
        </Button>
      </form>
    </>
  );
}

const JOB_TABS = [
  ['overview', 'Overview', ''],
  ['matching', 'Matching', 'Phase 5'],
  ['invitations', 'Invitations', 'Phase 5'],
  ['proposals', 'Proposals', 'Phase 5'],
  ['assignments', 'Assignments', 'Phase 5'],
  ['attendance', 'Attendance', 'Phase 6'],
  ['invoices', 'Invoices', 'Phase 7'],
] as const;

function EditHeadcountDialog({
  job,
  open,
  onOpenChange,
}: {
  job: JobView;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { update } = useAdminJobActions(job.id);
  const [required, setRequired] = useState<Record<string, number>>(() =>
    Object.fromEntries(job.positions.map((p) => [p.id, p.required])),
  );
  const [endDate, setEndDate] = useState(job.schedule.endDate);
  const [impact, setImpact] = useState<JobImpact[] | null>(null);
  const error = update.error ? toApiError(update.error) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setImpact(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change headcount and end date</DialogTitle>
        </DialogHeader>
        {impact ? (
          <div className="space-y-3">
            <Alert tone={impact.length ? 'warning' : 'success'}>
              {impact.length
                ? 'Saved. Some allocations need follow-up:'
                : 'Saved. No existing allocations are affected.'}
            </Alert>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {impact.map((i) => (
                <li key={`${i.positionId}${i.kind}`}>{i.message}</li>
              ))}
            </ul>
            <DialogFooter>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  setImpact(null);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            {job.positions.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3">
                <Label htmlFor={`req-${p.id}`} className="min-w-0">
                  {p.title}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {p.held + p.confirmed} already held or confirmed
                  </span>
                </Label>
                <Input
                  id={`req-${p.id}`}
                  type="number"
                  className="w-24"
                  min={Math.max(1, p.held + p.confirmed)}
                  value={required[p.id] ?? p.required}
                  onChange={(e) => setRequired({ ...required, [p.id]: e.target.valueAsNumber })}
                />
              </div>
            ))}
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="job-end">End date</Label>
              <Input
                id="job-end"
                type="date"
                className="w-44"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            {error && <Alert>{error.message}</Alert>}
            <DialogFooter>
              <Button
                loading={update.isPending}
                onClick={() =>
                  update.mutate(
                    {
                      version: job.version,
                      input: {
                        schedule: { ...job.schedule, endDate },
                        positions: job.positions.map((p) => ({
                          id: p.id,
                          skillId: p.skillId,
                          title: p.title,
                          minExperienceYears: p.minExperienceYears,
                          requiredCertDocTypeCodes: p.requiredCertDocTypeCodes,
                          shift: p.shift,
                          required: required[p.id] ?? p.required,
                          billRatePaise: p.billRatePaise,
                          billUnit: p.billUnit,
                          ...(p.payRatePaise !== undefined ? { payRatePaise: p.payRatePaise } : {}),
                          showPayRate: p.showPayRate,
                          allowPartialAvailability: p.allowPartialAvailability,
                        })),
                      },
                    },
                    { onSuccess: (r) => setImpact(r.impact) },
                  )
                }
              >
                Save
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AdminJobPage() {
  const { id = '' } = useParams();
  const job = useAdminJob(id);
  const actions = useAdminJobActions(id);
  const canManage = useCan('job.manage');
  const [tab, setTab] = useState<(typeof JOB_TABS)[number][0]>('overview');
  const [reasonFor, setReasonFor] = useState<'hold' | 'cancel' | null>(null);
  const [editing, setEditing] = useState(false);
  if (job.isLoading) return <Skeleton className="h-96 w-full" />;
  const j = job.data;
  if (!j) return <EmptyState title="Job not found" />;
  const can = (to: (typeof JOB_STATUSES)[number]) => canManage && canTransitionJob(j.status, to);
  const live = j.status !== 'COMPLETED' && j.status !== 'CANCELLED';
  const err =
    actions.open.error ??
    actions.hold.error ??
    actions.resume.error ??
    actions.cancel.error ??
    actions.complete.error;
  return (
    <>
      <BackLink to="/admin/jobs">Jobs</BackLink>
      <PageHeader
        title={j.jobNo}
        description={`${j.title}`}
        actions={
          <>
            <StatusBadge status={j.status} />
            {j.status === 'DRAFT' && canManage && (
              <Button size="sm" loading={actions.open.isPending} onClick={() => actions.open.mutate()}>
                Open job
              </Button>
            )}
            {j.status === 'ON_HOLD' && canManage && (
              <Button size="sm" loading={actions.resume.isPending} onClick={() => actions.resume.mutate()}>
                Resume
              </Button>
            )}
            {can('ON_HOLD') && j.status !== 'DRAFT' && (
              <Button size="sm" variant="outline" onClick={() => setReasonFor('hold')}>
                Put on hold
              </Button>
            )}
            {can('COMPLETED') && (
              <Button
                size="sm"
                variant="outline"
                loading={actions.complete.isPending}
                onClick={() => actions.complete.mutate()}
              >
                Complete
              </Button>
            )}
            {live && canManage && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Edit headcount
              </Button>
            )}
            {can('CANCELLED') && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => setReasonFor('cancel')}
              >
                Cancel job
              </Button>
            )}
          </>
        }
      />
      <ErrorAlert error={err} />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b" role="tablist">
        {JOB_TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              tab === key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'overview' ? (
        <div className="space-y-4">
          <Card>
            <CardContent className="grid gap-4 pt-6 sm:grid-cols-3">
              <Detail label="Company">
                <Link className="underline" to={`/admin/companies/${j.companyId}`}>
                  {j.companyName}
                </Link>
              </Detail>
              <Detail label="Site">
                {j.siteName}
                {j.siteCity ? `, ${j.siteCity}` : ''}
              </Detail>
              <Detail label="Service">{j.categoryName}</Detail>
              <Detail label="Schedule">{formatSchedule(j.schedule)}</Detail>
              <Detail label="Billing">{humanize(j.billingBasis)}</Detail>
              <Detail label="Quotation">
                {j.quotationId ? (
                  <Link className="underline" to={`/admin/quotations/${j.quotationId}`}>
                    {j.quotationNo}
                  </Link>
                ) : (
                  'Manual job'
                )}
              </Detail>
              {j.instructions && (
                <div className="sm:col-span-3">
                  <Detail label="Instructions">
                    <span className="whitespace-pre-line">{j.instructions}</span>
                  </Detail>
                </div>
              )}
              {j.cancellation && (
                <Detail label="Cancelled">{`${formatDateTime(j.cancellation.at)}: ${j.cancellation.reason}`}</Detail>
              )}
            </CardContent>
          </Card>
          <PositionsTable positions={j.positions} admin />
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2 text-sm">
                {j.statusHistory?.map((h, i) => (
                  <li key={i} className="flex flex-wrap gap-2">
                    <span className="text-muted-foreground">{formatDateTime(h.at)}</span>
                    <span>
                      {h.from === 'NEW' ? 'Created as' : `${humanize(h.from)} →`}{' '}
                      <strong>{humanize(h.to)}</strong>
                    </span>
                    {h.reason && <span className="text-muted-foreground">({h.reason})</span>}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      ) : (
        <EmptyState
          title={`${JOB_TABS.find(([k]) => k === tab)?.[1]} arrives in ${JOB_TABS.find(([k]) => k === tab)?.[2]}`}
          description="This workspace tab is wired up and will show its records once the module is delivered."
        />
      )}
      <ReasonDialog
        open={!!reasonFor}
        onOpenChange={(o) => !o && setReasonFor(null)}
        title={reasonFor === 'cancel' ? `Cancel ${j.jobNo}?` : `Put ${j.jobNo} on hold?`}
        confirmLabel={reasonFor === 'cancel' ? 'Cancel job' : 'Put on hold'}
        onConfirm={(r) =>
          reasonFor === 'cancel' ? actions.cancel.mutateAsync(r) : actions.hold.mutateAsync(r)
        }
      />
      {editing && <EditHeadcountDialog job={j} open={editing} onOpenChange={setEditing} />}
    </>
  );
}
