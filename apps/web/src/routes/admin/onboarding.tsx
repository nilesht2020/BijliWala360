import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, Check, Eye, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  registrationPlanSchema,
  VERIFICATION_STATES,
  type CategoryView,
  type DocumentView,
  type ProfessionalView,
  type RegistrationPaymentView,
  type RegistrationPlanInput,
  type RegistrationPlanView,
  type RegistrationRefundView,
  type RegistrationView,
  type SkillView,
  type VendorView,
} from '@bijliwala/contracts';
import { useCan } from '@/app/auth';
import { DataTable, useListParams } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/layout/confirm-dialog';
import { EmptyState, PageHeader, StatusBadge } from '@/components/layout/page-parts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import {
  useAdminCategories,
  useAdminPlans,
  useAdminSkills,
  useCatalogMutations,
  useFinanceActions,
  useIdentityConflicts,
  usePendingWorkers,
  useRegistrationDetail,
  useRegistrationPayments,
  useRegistrationRefunds,
  useRegistrationsQueue,
  useResolveConflict,
  useSavePlan,
  useVerificationActions,
  useVerifyWorker,
} from '@/features/admin/onboarding-api';
import { openDocument } from '@/features/providers/api';
import type { ApiError } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMoney, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';

/* =============================================================== verification queue */

const queueColumns: ColumnDef<RegistrationView, unknown>[] = [
  {
    header: 'Provider',
    accessorKey: 'providerName',
    cell: ({ row }) => <span className="font-medium">{row.original.providerName}</span>,
  },
  { header: 'Type', accessorKey: 'providerType', cell: ({ getValue }) => humanize(String(getValue())) },
  { header: 'Plan', id: 'plan', cell: ({ row }) => row.original.plan?.name ?? '—' },
  { header: 'Fee', id: 'fee', cell: ({ row }) => <StatusBadge status={row.original.payment.status} /> },
  {
    header: 'Verification',
    id: 'v',
    cell: ({ row }) => <StatusBadge status={row.original.verification.status} />,
  },
  { header: 'Submitted', id: 's', cell: ({ row }) => formatDateTime(row.original.verification.submittedAt) },
];

export function VerificationPage() {
  const navigate = useNavigate();
  const { page, pageSize, filters, setPage, setFilter } = useListParams([
    'verificationStatus',
    'providerType',
  ] as const);
  const status = filters.verificationStatus ?? 'PENDING';
  const queue = useRegistrationsQueue({
    page,
    pageSize,
    verificationStatus: status,
    ...(filters.providerType ? { providerType: filters.providerType } : {}),
  });
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<'registrations' | 'workers' | 'conflicts'>(
    initialTab === 'workers' || initialTab === 'conflicts' ? initialTab : 'registrations',
  );

  return (
    <>
      <PageHeader
        title="Verification"
        description="Review provider registrations, vendor workers and identity conflicts."
      />
      <div className="mb-4 flex gap-2" role="tablist">
        {(['registrations', 'workers', 'conflicts'] as const).map((t) => (
          <Button
            key={t}
            role="tab"
            aria-selected={tab === t}
            variant={tab === t ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTab(t)}
          >
            {humanize(t)}
          </Button>
        ))}
      </div>
      {tab === 'registrations' && (
        <DataTable
          columns={queueColumns}
          data={queue.data?.items}
          meta={queue.data?.meta}
          isLoading={queue.isLoading}
          onPageChange={setPage}
          getRowId={(r) => r.id}
          onRowClick={(r) => navigate(`/admin/verification/${r.id}`)}
          emptyTitle="Nothing waiting here"
          toolbar={
            <>
              <Select
                aria-label="Verification status"
                className="sm:w-56"
                value={status}
                onChange={(e) => setFilter('verificationStatus', e.target.value)}
              >
                {VERIFICATION_STATES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Provider type"
                className="sm:w-48"
                value={filters.providerType ?? ''}
                onChange={(e) => setFilter('providerType', e.target.value || undefined)}
              >
                <option value="">All providers</option>
                <option value="PROFESSIONAL">Professionals</option>
                <option value="VENDOR">Vendors</option>
              </Select>
            </>
          }
        />
      )}
      {tab === 'workers' && <PendingWorkers />}
      {tab === 'conflicts' && <IdentityConflicts />}
    </>
  );
}

function PendingWorkers() {
  const workers = usePendingWorkers();
  const verify = useVerifyWorker();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  if (workers.isLoading) return <Skeleton className="h-40" />;
  if (!workers.data?.items.length) return <EmptyState title="No workers waiting for verification" />;
  return (
    <Card className="divide-y">
      {workers.data.items.map((w) => (
        <div key={w.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">{w.fullName}</p>
            <p className="text-xs text-muted-foreground">
              {humanize(w.identity.idType)} ••{w.identity.idLast4} ·{' '}
              {w.skills.map((s) => s.skillName).join(', ')} · {w.experienceYears} yrs
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setRejecting(w.id)}>
              <X /> Reject
            </Button>
            <Button
              size="sm"
              loading={verify.isPending && verify.variables?.id === w.id}
              onClick={() => verify.mutate({ id: w.id, decision: 'APPROVED' })}
            >
              <Check /> Approve
            </Button>
          </div>
        </div>
      ))}
      <ConfirmDialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        title="Reject this worker?"
        destructive
        confirmLabel="Reject"
        onConfirm={async () => {
          if (rejecting) await verify.mutateAsync({ id: rejecting, decision: 'REJECTED', comment: reason });
          setReason('');
        }}
      >
        <Textarea
          aria-label="Reason"
          placeholder="Reason (shared with the vendor)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </ConfirmDialog>
    </Card>
  );
}

function IdentityConflicts() {
  const conflicts = useIdentityConflicts();
  const resolve = useResolveConflict();
  const [note, setNote] = useState<Record<string, string>>({});
  if (conflicts.isLoading) return <Skeleton className="h-40" />;
  if (!conflicts.data?.length)
    return (
      <EmptyState
        title="No identity conflicts"
        description="Attempts to register the same person twice appear here."
      />
    );
  return (
    <Card className="divide-y">
      {conflicts.data.map((c) => (
        <div key={c.id} className="flex flex-col gap-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">
              {c.attemptedRole.name} tried to register as {humanize(c.attemptedRole.type).toLowerCase()}
            </p>
            <StatusBadge status={c.status} />
          </div>
          <p className="text-xs text-muted-foreground">
            Matched on {c.matchedOn.join(' and ')} with an existing{' '}
            {c.existingRole ? humanize(c.existingRole.type).toLowerCase() : 'profile'} ·{' '}
            {formatDateTime(c.createdAt)}
          </p>
          {c.status === 'OPEN' ? (
            <div className="flex gap-2">
              <Input
                placeholder="Resolution note"
                aria-label="Resolution note"
                value={note[c.id] ?? ''}
                onChange={(e) => setNote({ ...note, [c.id]: e.target.value })}
              />
              <Button
                size="sm"
                disabled={(note[c.id] ?? '').length < 3}
                onClick={() => resolve.mutate({ id: c.id, note: note[c.id] ?? '' })}
              >
                Resolve
              </Button>
            </div>
          ) : (
            <p className="text-sm">Note: {c.note}</p>
          )}
        </div>
      ))}
    </Card>
  );
}

/* =============================================================== registration review */

function ProviderSummary({ provider }: { provider: ProfessionalView | VendorView }) {
  const rows: Array<[string, string]> =
    'legalName' in provider
      ? [
          ['Entity', humanize(provider.entityType)],
          ['PAN', `••${provider.panLast4}`],
          ['GSTIN', provider.gstin ?? '—'],
          ['Address', `${provider.registeredAddress.line1}, ${provider.registeredAddress.city}`],
          [
            'Locations',
            provider.operatingLocations.map((l) => `${l.label} (${l.radiusKm} km)`).join(', ') || '—',
          ],
          ['Contacts', provider.contacts.map((c) => `${c.name} ${c.mobile}`).join(', ') || '—'],
          ['Workers', `${provider.activeWorkerCount}${provider.workerCap ? ` / ${provider.workerCap}` : ''}`],
        ]
      : [
          ['Date of birth', formatDate(provider.dob)],
          [
            'ID',
            provider.identity ? `${humanize(provider.identity.idType)} ••${provider.identity.idLast4}` : '—',
          ],
          [
            'Address',
            provider.address
              ? `${provider.address.line1}, ${provider.address.city} ${provider.address.pincode}`
              : '—',
          ],
          ['Experience', `${provider.experienceYears ?? '—'} years`],
          ['Travel radius', provider.radiusKm ? `${provider.radiusKm} km` : '—'],
          ['Languages', provider.languages.join(', ') || '—'],
          [
            'Skills',
            provider.skills
              .map(
                (s) => `${s.skillName ?? s.skillId} (${humanize(s.proficiency).toLowerCase()}, ${s.years}y)`,
              )
              .join(', ') || '—',
          ],
        ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DocumentReviewRow({
  doc,
  required,
  onReview,
  busy,
}: {
  doc: DocumentView;
  required: boolean;
  onReview: (decision: 'VERIFIED' | 'REJECTED', comment?: string) => void;
  busy: boolean;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const current = !['SUPERSEDED', 'PENDING_UPLOAD', 'SCANNING'].includes(doc.status);
  return (
    <li className={cn('flex flex-col gap-2 py-3', !current && 'opacity-60')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{doc.typeName ?? doc.typeCode}</span>
          {required && <Badge tone="primary">Required</Badge>}
          <StatusBadge status={doc.status} />
          {doc.numberLast4 && <span className="text-xs text-muted-foreground">No. ••{doc.numberLast4}</span>}
          {doc.expiresOn && (
            <span className="text-xs text-muted-foreground">Expires {formatDate(doc.expiresOn)}</span>
          )}
          <span className="text-xs text-muted-foreground">v{doc.versionNo}</span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openDocument(doc.id, doc.fileName)}
            aria-label={`View ${doc.fileName}`}
          >
            <Eye />
          </Button>
          {current && ['UPLOADED', 'VERIFIED', 'REJECTED'].includes(doc.status) && (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting((r) => !r)}>
                Reject
              </Button>
              <Button
                size="sm"
                disabled={busy || doc.status === 'VERIFIED'}
                onClick={() => onReview('VERIFIED')}
              >
                Verify
              </Button>
            </>
          )}
        </div>
      </div>
      {rejecting && (
        <div className="flex gap-2">
          <Input
            placeholder="What is wrong with this document?"
            aria-label="Rejection comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <Button
            size="sm"
            variant="destructive"
            disabled={comment.length < 3}
            onClick={() => {
              onReview('REJECTED', comment);
              setRejecting(false);
            }}
          >
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}

type Decision = 'approve' | 'reject' | 'changes' | 'waive';

export function RegistrationReviewPage() {
  const { id = '' } = useParams();
  const detail = useRegistrationDetail(id);
  const actions = useVerificationActions(id);
  const canWaive = useCan('registration.waive');
  const [decision, setDecision] = useState<Decision | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (detail.isLoading) return <Skeleton className="h-96" />;
  if (!detail.data) return <EmptyState title="Registration not found" />;
  const { registration: reg, provider, documents, requiredDocTypeCodes, payments, refunds } = detail.data;
  const required = new Set(requiredDocTypeCodes);
  const pending = reg.verification.status === 'PENDING';

  const run = async () => {
    setError(null);
    try {
      if (decision === 'approve') await actions.approve.mutateAsync();
      if (decision === 'reject') await actions.reject.mutateAsync(text);
      if (decision === 'changes') await actions.requestChanges.mutateAsync(text);
      if (decision === 'waive') await actions.waive.mutateAsync(text);
      setText('');
    } catch (e) {
      setError((e as ApiError).message);
      throw e;
    }
  };

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link to="/admin/verification">
          <ArrowLeft /> Verification
        </Link>
      </Button>
      <PageHeader
        title={reg.providerName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {humanize(reg.providerType)} <StatusBadge status={reg.providerStatus} />{' '}
            <StatusBadge
              status={reg.verification.status}
              label={`Verification ${humanize(reg.verification.status).toLowerCase()}`}
            />
          </span>
        }
        actions={
          pending && (
            <>
              <Button variant="outline" onClick={() => setDecision('changes')}>
                Request changes
              </Button>
              <Button variant="destructive" onClick={() => setDecision('reject')}>
                Reject
              </Button>
              <Button onClick={() => setDecision('approve')}>
                <Check /> Approve
              </Button>
            </>
          )
        }
      />
      {error && !decision && <Alert className="mb-4">{error}</Alert>}
      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <ProviderSummary provider={provider} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Registration fee</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p>
                {reg.plan ? `${reg.plan.name} · ${formatMoney(reg.plan.totalPaise)}` : 'No plan chosen'} ·{' '}
                <StatusBadge status={reg.payment.status} />
              </p>
              {payments.map((p) => (
                <p key={p.id} className="text-xs text-muted-foreground">
                  {humanize(p.mode)} {p.method ? `(${humanize(p.method)})` : ''} {formatMoney(p.amountPaise)}{' '}
                  · {humanize(p.status)} · {formatDateTime(p.createdAt)}
                </p>
              ))}
              {refunds.map((r) => (
                <p key={r.id} className="text-xs text-muted-foreground">
                  Refund {formatMoney(r.amountPaise)} · {humanize(r.status)}
                </p>
              ))}
              {canWaive && reg.payment.status === 'UNPAID' && reg.plan && (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  onClick={() => setDecision('waive')}
                >
                  Waive fee
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Documents</CardTitle>
          </CardHeader>
          <CardContent>
            {documents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No documents uploaded.</p>
            ) : (
              <ul className="divide-y">
                {documents.map((d) => (
                  <DocumentReviewRow
                    key={d.id}
                    doc={d}
                    required={required.has(d.typeCode)}
                    busy={actions.reviewDocument.isPending}
                    onReview={(dec, comment) =>
                      actions.reviewDocument.mutate(
                        { docId: d.id, decision: dec, comment },
                        { onError: (e) => setError((e as ApiError).message) },
                      )
                    }
                  />
                ))}
              </ul>
            )}
            {[...required]
              .filter((c) => !documents.some((d) => d.typeCode === c && d.status !== 'SUPERSEDED'))
              .map((c) => (
                <Alert key={c} tone="warning" className="mt-2">
                  Missing required document: {humanize(c)}
                </Alert>
              ))}
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={!!decision}
        onOpenChange={(o) => {
          if (!o) {
            setDecision(null);
            setError(null);
          }
        }}
        title={
          {
            approve: 'Approve this registration?',
            reject: 'Reject this registration?',
            changes: 'Request changes?',
            waive: 'Waive the registration fee?',
          }[decision ?? 'approve']
        }
        description={
          decision === 'approve'
            ? 'The provider becomes verified and starts receiving matching invitations.'
            : decision === 'reject'
              ? 'Any refund due under the plan is created for finance approval.'
              : undefined
        }
        destructive={decision === 'reject'}
        confirmLabel={decision ? humanize(decision === 'changes' ? 'request changes' : decision) : 'Confirm'}
        onConfirm={run}
      >
        {decision && decision !== 'approve' && (
          <Textarea
            aria-label="Reason"
            placeholder={
              decision === 'waive' ? 'Why is the fee waived?' : 'This message is shared with the provider.'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        {error && <Alert>{error}</Alert>}
      </ConfirmDialog>
    </>
  );
}

/* =============================================================== catalogue & plans */

function CategoryNode({
  c,
  onAddChild,
  onToggle,
  onDelete,
}: {
  c: CategoryView;
  onAddChild: (parent: CategoryView) => void;
  onToggle: (c: CategoryView) => void;
  onDelete: (c: CategoryView) => void;
}) {
  return (
    <li className="py-1">
      <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-muted">
        <span className={cn('text-sm', !c.isActive && 'text-muted-foreground line-through')}>
          {c.name} <span className="font-mono text-xs text-muted-foreground">/{c.slug}</span>
        </span>
        <span className="flex gap-1">
          {c.level < 3 && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Add under ${c.name}`}
              onClick={() => onAddChild(c)}
            >
              <Plus />
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onToggle(c)}>
            {c.isActive ? 'Hide' : 'Show'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            aria-label={`Delete ${c.name}`}
            onClick={() => onDelete(c)}
          >
            <Trash2 />
          </Button>
        </span>
      </div>
      {!!c.children?.length && (
        <ul className="ml-4 border-l pl-2">
          {c.children.map((ch) => (
            <CategoryNode
              key={ch.id}
              c={ch}
              onAddChild={onAddChild}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function CatalogAdminPage() {
  const categories = useAdminCategories();
  const skills = useAdminSkills();
  const m = useCatalogMutations();
  const [adding, setAdding] = useState<{ parent: CategoryView | null } | null>(null);
  const [name, setName] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [skill, setSkill] = useState({ code: '', name: '', categoryId: '', docs: '' });
  const [deleting, setDeleting] = useState<CategoryView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteError(null);
    try {
      await m.deleteCategory.mutateAsync(deleting.id);
    } catch (e) {
      setDeleteError((e as ApiError).message);
      throw e;
    }
  };
  const flat = (list: CategoryView[]): CategoryView[] => list.flatMap((c) => [c, ...flat(c.children ?? [])]);
  const all = flat(categories.data ?? []);
  const catName = new Map(all.map((c) => [c.id, c.name]));
  const [editingSkill, setEditingSkill] = useState<{
    skill: SkillView;
    name: string;
    categoryIds: string[];
    docs: string;
    sacCode: string;
    isActive: boolean;
  } | null>(null);
  const [deletingSkill, setDeletingSkill] = useState<SkillView | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const saveSkill = () => {
    if (!editingSkill) return;
    setSkillError(null);
    m.updateSkill.mutate(
      {
        id: editingSkill.skill.id,
        input: {
          name: editingSkill.name.trim(),
          categoryIds: editingSkill.categoryIds,
          requiredDocTypeCodes: editingSkill.docs
            .split(',')
            .map((d) => d.trim().toUpperCase())
            .filter(Boolean),
          ...(editingSkill.sacCode.trim() ? { sacCode: editingSkill.sacCode.trim() } : {}),
          isActive: editingSkill.isActive,
        },
      },
      {
        onSuccess: () => setEditingSkill(null),
        onError: (e) => setSkillError((e as ApiError).message),
      },
    );
  };
  const confirmDeleteSkill = async () => {
    if (!deletingSkill) return;
    setSkillError(null);
    try {
      await m.deleteSkill.mutateAsync(deletingSkill.id);
    } catch (e) {
      setSkillError((e as ApiError).message);
      throw e;
    }
  };
  const err = (m.createCategory.error ?? m.createSkill.error ?? m.updateCategory.error) as ApiError | null;

  return (
    <>
      <PageHeader
        title="Service catalogue"
        description="Categories shown on the website and skills providers can offer."
      />
      {err && <Alert className="mb-4">{err.message}</Alert>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Categories</CardTitle>
            <Button size="sm" onClick={() => setAdding({ parent: null })}>
              <Plus /> Category
            </Button>
          </CardHeader>
          <CardContent>
            {categories.isLoading ? (
              <Skeleton className="h-40" />
            ) : (
              <ul>
                {categories.data?.map((c) => (
                  <CategoryNode
                    key={c.id}
                    c={c}
                    onAddChild={(parent) => setAdding({ parent })}
                    onToggle={(cat) =>
                      m.updateCategory.mutate({ id: cat.id, input: { isActive: !cat.isActive } })
                    }
                    onDelete={(cat) => {
                      setDeleteError(null);
                      setDeleting(cat);
                    }}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Skills</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="divide-y text-sm">
              {skills.data?.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                  <span className={cn('min-w-0', !s.isActive && 'text-muted-foreground line-through')}>
                    {s.name} <span className="font-mono text-xs text-muted-foreground">{s.code}</span>
                    <span className="block text-xs text-muted-foreground">
                      {s.categoryIds.map((id) => catName.get(id) ?? '?').join(', ')}
                      {s.requiredDocTypeCodes.length > 0 && ` · docs: ${s.requiredDocTypeCodes.join(', ')}`}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${s.name}`}
                      onClick={() => {
                        setSkillError(null);
                        setEditingSkill({
                          skill: s,
                          name: s.name,
                          categoryIds: s.categoryIds,
                          docs: s.requiredDocTypeCodes.join(', '),
                          sacCode: s.sacCode ?? '',
                          isActive: s.isActive,
                        });
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      aria-label={`Delete ${s.name}`}
                      onClick={() => {
                        setSkillError(null);
                        setDeletingSkill(s);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                placeholder="CODE"
                aria-label="Skill code"
                value={skill.code}
                onChange={(e) => setSkill({ ...skill, code: e.target.value.toUpperCase() })}
              />
              <Input
                placeholder="Name"
                aria-label="Skill name"
                value={skill.name}
                onChange={(e) => setSkill({ ...skill, name: e.target.value })}
              />
              <Select
                aria-label="Category"
                value={skill.categoryId}
                onChange={(e) => setSkill({ ...skill, categoryId: e.target.value })}
              >
                <option value="">Category…</option>
                {all.map((c) => (
                  <option key={c.id} value={c.id}>
                    {'— '.repeat(c.level - 1)}
                    {c.name}
                  </option>
                ))}
              </Select>
              <Input
                placeholder="Required docs, e.g. ELECTRICAL_LICENCE"
                aria-label="Required document codes"
                value={skill.docs}
                onChange={(e) => setSkill({ ...skill, docs: e.target.value.toUpperCase() })}
              />
              <Button
                className="sm:col-span-2"
                disabled={!skill.code || !skill.name || !skill.categoryId}
                loading={m.createSkill.isPending}
                onClick={() =>
                  m.createSkill.mutate(
                    {
                      code: skill.code,
                      name: skill.name,
                      categoryIds: [skill.categoryId],
                      requiredDocTypeCodes: skill.docs
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                      isActive: true,
                    },
                    { onSuccess: () => setSkill({ code: '', name: '', categoryId: '', docs: '' }) },
                  )
                }
              >
                Add skill
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
      <PlansAdmin />
      <ConfirmDialog
        open={!!deletingSkill}
        onOpenChange={(o) => !o && setDeletingSkill(null)}
        title={`Delete skill "${deletingSkill?.name ?? ''}"?`}
        description="This permanently removes the skill. A skill used by providers, vendor workers, enquiries, quotations or jobs cannot be deleted; deactivate it instead (Edit, then untick Active)."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDeleteSkill}
      >
        {skillError && <Alert>{skillError}</Alert>}
      </ConfirmDialog>
      <Dialog open={!!editingSkill} onOpenChange={(o) => !o && setEditingSkill(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit skill {editingSkill?.skill.code}</DialogTitle>
          </DialogHeader>
          {editingSkill && (
            <div className="flex flex-col gap-3">
              <Label htmlFor="skill-edit-name">Name</Label>
              <Input
                id="skill-edit-name"
                value={editingSkill.name}
                onChange={(e) => setEditingSkill({ ...editingSkill, name: e.target.value })}
              />
              <span className="text-sm font-medium">Categories</span>
              <div className="max-h-48 overflow-y-auto rounded-md border p-2">
                {all.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input
                      type="checkbox"
                      checked={editingSkill.categoryIds.includes(c.id)}
                      onChange={(e) =>
                        setEditingSkill({
                          ...editingSkill,
                          categoryIds: e.target.checked
                            ? [...editingSkill.categoryIds, c.id]
                            : editingSkill.categoryIds.filter((id) => id !== c.id),
                        })
                      }
                    />
                    {'— '.repeat(c.level - 1)}
                    {c.name}
                  </label>
                ))}
              </div>
              <Label htmlFor="skill-edit-docs">Required document codes (comma separated)</Label>
              <Input
                id="skill-edit-docs"
                value={editingSkill.docs}
                onChange={(e) => setEditingSkill({ ...editingSkill, docs: e.target.value.toUpperCase() })}
              />
              <Label htmlFor="skill-edit-sac">SAC code (optional)</Label>
              <Input
                id="skill-edit-sac"
                value={editingSkill.sacCode}
                onChange={(e) => setEditingSkill({ ...editingSkill, sacCode: e.target.value })}
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editingSkill.isActive}
                  onChange={(e) => setEditingSkill({ ...editingSkill, isActive: e.target.checked })}
                />
                Active (inactive skills are not offered for new registrations or enquiries)
              </label>
              {skillError && <Alert>{skillError}</Alert>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSkill(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                !editingSkill || editingSkill.name.trim().length < 2 || editingSkill.categoryIds.length === 0
              }
              loading={m.updateSkill.isPending}
              onClick={saveSkill}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete "${deleting?.name ?? ''}"?`}
        description="This permanently removes the category. A category that has sub-categories or skills, or is used by providers, enquiries or jobs, cannot be deleted; hide it instead."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      >
        {deleteError && <Alert>{deleteError}</Alert>}
      </ConfirmDialog>
      <Dialog open={!!adding} onOpenChange={(o) => !o && setAdding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {adding?.parent ? `New category under ${adding.parent.name}` : 'New category'}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Label htmlFor="cat-name">Name</Label>
            <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} />
            <Label htmlFor="cat-img">Image URL (optional)</Label>
            <Input id="cat-img" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(null)}>
              Cancel
            </Button>
            <Button
              disabled={name.trim().length < 2}
              loading={m.createCategory.isPending}
              onClick={() =>
                m.createCategory.mutate(
                  {
                    name,
                    parentId: adding?.parent?.id ?? null,
                    displayOrder: 0,
                    ...(imageUrl ? { imageUrl } : {}),
                  },
                  {
                    onSuccess: () => {
                      setAdding(null);
                      setName('');
                      setImageUrl('');
                    },
                  },
                )
              }
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PlansAdmin() {
  const plans = useAdminPlans();
  const save = useSavePlan();
  const [editing, setEditing] = useState<{ plan?: RegistrationPlanView; json: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toInput = (p: RegistrationPlanView): RegistrationPlanInput => {
    const { id: _id, taxPaise: _t, totalPaise: _tp, version: _v, ...rest } = p;
    return rest;
  };
  const submit = () => {
    setError(null);
    let parsed;
    try {
      parsed = registrationPlanSchema.safeParse(JSON.parse(editing?.json ?? ''));
    } catch {
      setError('This is not valid JSON.');
      return;
    }
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    save.mutate(
      { id: editing?.plan?.id, version: editing?.plan?.version, input: parsed.data },
      { onSuccess: () => setEditing(null), onError: (e) => setError((e as ApiError).message) },
    );
  };
  const template: RegistrationPlanInput = {
    code: 'NEW_PLAN',
    name: 'New plan',
    providerType: 'PROFESSIONAL',
    feePaise: 99900,
    gstRateBp: 1800,
    sacCode: '998519',
    features: [],
    maxWorkers: null,
    mandatoryDocTypeCodes: ['PHOTO'],
    gstinRequired: false,
    offlinePaymentAllowed: true,
    refundPolicy: { onRejection: 'FULL' },
    isActive: true,
    displayOrder: 0,
  };
  return (
    <Card className="mt-6">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Registration plans</CardTitle>
        <Button size="sm" onClick={() => setEditing({ json: JSON.stringify(template, null, 2) })}>
          <Plus /> Plan
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {plans.data?.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span>
                <span className="font-medium">{p.name}</span> · {humanize(p.providerType)} ·{' '}
                {formatMoney(p.totalPaise)} incl. GST
                {p.maxWorkers ? ` · ${p.maxWorkers} workers` : ''} {!p.isActive && <Badge>Inactive</Badge>}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Edit ${p.name}`}
                onClick={() => setEditing({ plan: p, json: JSON.stringify(toInput(p), null, 2) })}
              >
                <Pencil />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing?.plan ? `Edit ${editing.plan.name}` : 'New plan'}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Amounts are in paise (₹1 = 100). Price changes never affect providers who already paid.
          </p>
          <Textarea
            className="min-h-80 font-mono text-xs"
            aria-label="Plan definition"
            value={editing?.json ?? ''}
            onChange={(e) => setEditing(editing ? { ...editing, json: e.target.value } : null)}
          />
          {error && <Alert>{error}</Alert>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={submit}>
              Save plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* =============================================================== finance: registration payments & refunds */

export function FinancePage() {
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<'offline' | 'all' | 'refunds'>(
    initialTab === 'all' || initialTab === 'refunds' ? initialTab : 'offline',
  );
  const offline = useRegistrationPayments({
    page: 1,
    pageSize: 50,
    status: 'PENDING_VERIFICATION',
    mode: 'OFFLINE',
  });
  const all = useRegistrationPayments({ page: 1, pageSize: 50 });
  const refunds = useRegistrationRefunds({ page: 1, pageSize: 50 });
  const f = useFinanceActions();
  const [rejecting, setRejecting] = useState<{ kind: 'payment' | 'refund'; id: string } | null>(null);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState<Record<string, string>>({});
  const err = (f.verifyPayment.error ??
    f.approveRefund.error ??
    f.completeRefund.error ??
    f.rejectPayment.error ??
    f.rejectRefund.error) as ApiError | null;

  const paymentRow = (p: RegistrationPaymentView, actions: boolean) => (
    <li key={p.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm">
        <p className="font-medium">
          {p.providerName} · {formatMoney(p.amountPaise)}
        </p>
        <p className="text-xs text-muted-foreground">
          {humanize(p.mode)} {p.method ? `· ${humanize(p.method)}` : ''}{' '}
          {p.offline ? `· ref ${p.offline.reference} · paid ${formatDate(p.offline.paidOn)}` : ''}{' '}
          {p.gateway?.paymentId ? `· ${p.gateway.paymentId}` : ''} · {formatDateTime(p.createdAt)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {p.offline && (
          <Button
            size="sm"
            variant="ghost"
            aria-label="View payment proof"
            onClick={() => openDocument(p.offline?.proofDocId ?? '', 'Payment proof')}
          >
            <Eye />
          </Button>
        )}
        {actions ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setRejecting({ kind: 'payment', id: p.id })}>
              Reject
            </Button>
            <Button
              size="sm"
              loading={f.verifyPayment.isPending && f.verifyPayment.variables === p.id}
              onClick={() => f.verifyPayment.mutate(p.id)}
            >
              Verify
            </Button>
          </>
        ) : (
          <StatusBadge status={p.status} />
        )}
      </div>
    </li>
  );

  const refundRow = (r: RegistrationRefundView) => (
    <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm">
        <p className="font-medium">
          {formatMoney(r.amountPaise)} · {humanize(r.mode)}
        </p>
        <p className="text-xs text-muted-foreground">
          {r.reason} · {formatDateTime(r.createdAt)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={r.status} />
        {r.status === 'PENDING_APPROVAL' && (
          <>
            <Button size="sm" variant="outline" onClick={() => setRejecting({ kind: 'refund', id: r.id })}>
              Reject
            </Button>
            <Button size="sm" onClick={() => f.approveRefund.mutate(r.id)}>
              Approve
            </Button>
          </>
        )}
        {r.status === 'APPROVED' && r.mode === 'OFFLINE' && (
          <>
            <Input
              className="w-40"
              placeholder="Transfer ref"
              aria-label="Transfer reference"
              value={reference[r.id] ?? ''}
              onChange={(e) => setReference({ ...reference, [r.id]: e.target.value })}
            />
            <Button
              size="sm"
              disabled={(reference[r.id] ?? '').length < 4}
              onClick={() => f.completeRefund.mutate({ id: r.id, reference: reference[r.id] ?? '' })}
            >
              Mark paid
            </Button>
          </>
        )}
      </div>
    </li>
  );

  return (
    <>
      <PageHeader
        title="Finance"
        description="Registration fees: offline payment verification, payment history and refunds."
      />
      <div className="mb-4 flex gap-2" role="tablist">
        {(
          [
            ['offline', `To verify (${offline.data?.meta.total ?? 0})`],
            ['all', 'All payments'],
            ['refunds', 'Refunds'],
          ] as const
        ).map(([t, label]) => (
          <Button
            key={t}
            role="tab"
            aria-selected={tab === t}
            size="sm"
            variant={tab === t ? 'default' : 'outline'}
            onClick={() => setTab(t)}
          >
            {label}
          </Button>
        ))}
      </div>
      {err && <Alert className="mb-4">{err.message}</Alert>}
      <Card className="px-4">
        {tab === 'offline' &&
          (offline.data?.items.length ? (
            <ul className="divide-y">{offline.data.items.map((p) => paymentRow(p, true))}</ul>
          ) : (
            <EmptyState title="No offline payments waiting" className="my-4 border-0" />
          ))}
        {tab === 'all' &&
          (all.data?.items.length ? (
            <ul className="divide-y">{all.data.items.map((p) => paymentRow(p, false))}</ul>
          ) : (
            <EmptyState title="No payments yet" className="my-4 border-0" />
          ))}
        {tab === 'refunds' &&
          (refunds.data?.items.length ? (
            <ul className="divide-y">{refunds.data.items.map(refundRow)}</ul>
          ) : (
            <EmptyState title="No refunds" className="my-4 border-0" />
          ))}
      </Card>
      <ConfirmDialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={rejecting?.kind === 'refund' ? 'Reject this refund?' : 'Reject this payment?'}
        destructive
        confirmLabel="Reject"
        onConfirm={async () => {
          if (!rejecting) return;
          if (rejecting.kind === 'payment') await f.rejectPayment.mutateAsync({ id: rejecting.id, reason });
          else await f.rejectRefund.mutateAsync({ id: rejecting.id, reason });
          setReason('');
        }}
      >
        <Textarea
          aria-label="Reason"
          placeholder="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">The reason is recorded in the audit log.</p>
      </ConfirmDialog>
    </>
  );
}
