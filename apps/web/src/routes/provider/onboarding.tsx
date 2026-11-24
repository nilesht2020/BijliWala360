import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Circle, FileText, LocateFixed, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { type z } from 'zod';
import {
  ENTITY_TYPES,
  ID_TYPES,
  OFFLINE_METHODS,
  PROFICIENCIES,
  professionalProfileSchema,
  vendorCreateSchema,
  type DocumentTypeView,
  type ProfessionalUpdateInput,
  type ProfessionalView,
  type ProviderStatus,
  type ReadinessView,
  type RegistrationView,
  type VendorCreateInput,
  type VendorView,
} from '@bijliwala/contracts';
import { useAuth } from '@/app/auth';
import { FileUpload } from '@/components/forms/file-upload';
import { applyServerErrors, FormField } from '@/components/forms/form-field';
import { EmptyState, PageHeader, StatusBadge } from '@/components/layout/page-parts';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Skeleton,
} from '@/components/ui/primitives';
import {
  documentUploadApi,
  openDocument,
  useCategories,
  useDocumentImageUrl,
  useDocuments,
  useDocumentTypes,
  useInvalidateProvider,
  useMyPayments,
  useMyProfessional,
  useMyVendor,
  usePlans,
  useProfessionalMutations,
  useReadiness,
  useRegistration,
  useRegistrationMutations,
  useSkills,
  useVendorMutations,
} from '@/features/providers/api';
import type { ApiError } from '@/lib/api-client';
import { formatMoney, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';

/* =============================================================== shared pieces */

function Section({
  step,
  title,
  description,
  done,
  children,
}: {
  step: number;
  title: string;
  description?: ReactNode;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold',
            done ? 'bg-success text-success-foreground' : 'bg-accent text-primary',
          )}
        >
          {done ? <CheckCircle2 className="size-4" /> : step}
        </span>
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const STATUS_COPY: Partial<
  Record<ProviderStatus, { tone: 'info' | 'success' | 'warning' | 'danger'; text: string }>
> = {
  DRAFT: { tone: 'info', text: 'Complete the steps below, then submit your registration for verification.' },
  PENDING_PAYMENT: {
    tone: 'warning',
    text: 'Your registration is submitted. It goes to verification as soon as the fee is received.',
  },
  PENDING_VERIFICATION: {
    tone: 'info',
    text: 'Our verification team is reviewing your profile and documents. We will notify you of the outcome.',
  },
  CHANGES_REQUESTED: {
    tone: 'warning',
    text: 'The verification team asked for changes. Update your details and submit again.',
  },
  APPROVED: {
    tone: 'success',
    text: 'You are verified. You will receive job invitations that match your skills and location.',
  },
  REJECTED: {
    tone: 'danger',
    text: 'Your registration was not approved. Any refund due is processed automatically.',
  },
  SUSPENDED: { tone: 'danger', text: 'Your account is suspended. Contact support for help.' },
};

function StatusBanner({
  status,
  registration,
}: {
  status: ProviderStatus;
  registration?: RegistrationView | null;
}) {
  const copy = STATUS_COPY[status];
  const lastDecision = registration?.verification.decisions.at(-1);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Registration status</span>
        <StatusBadge status={status} />
      </div>
      {copy && <Alert tone={copy.tone}>{copy.text}</Alert>}
      {status === 'CHANGES_REQUESTED' && registration?.verification.changesRequested && (
        <Alert tone="warning">Reviewer note: {registration.verification.changesRequested.comment}</Alert>
      )}
      {status === 'REJECTED' && lastDecision?.reason && <Alert>Reason: {lastDecision.reason}</Alert>}
    </div>
  );
}

const EDITABLE: ProviderStatus[] = ['DRAFT', 'PENDING_PAYMENT', 'CHANGES_REQUESTED'];

/* =============================================================== profile photo (after approval) */

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '?'
  );
}

/**
 * Shown once a professional is approved: their profile photo with name and verified badge, and a
 * control to add or change the photo (uploaded as the PHOTO document; the old one is superseded).
 */
function ProfilePhotoCard({ pro }: { pro: ProfessionalView }) {
  const invalidate = useInvalidateProvider();
  const types = useDocumentTypes();
  const docs = useDocuments('PROFESSIONAL', pro.id);
  const photoType = types.data?.find((t) => t.code === 'PHOTO');
  const photo = docs.data?.find((d) => d.typeCode === 'PHOTO' && d.status !== 'REJECTED');
  const photoUrl = useDocumentImageUrl(photo?.id);
  const [broken, setBroken] = useState(false);
  const showImage = !!photoUrl.data && !broken;

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 pt-6 sm:flex-row sm:items-center">
        <button
          type="button"
          className="relative size-24 shrink-0 overflow-hidden rounded-full border-2 border-success bg-accent text-2xl font-bold text-primary disabled:cursor-default"
          onClick={() => photo && openDocument(photo.id, 'Profile photo')}
          disabled={!photo}
          aria-label={photo ? 'View profile photo' : undefined}
        >
          {showImage ? (
            <img
              src={photoUrl.data}
              alt={`${pro.fullName} profile photo`}
              className="size-full object-cover"
              onError={() => setBroken(true)}
            />
          ) : photoUrl.isLoading ? (
            <Skeleton className="size-full rounded-full" />
          ) : (
            <span aria-hidden className="flex size-full items-center justify-center">
              {initials(pro.fullName)}
            </span>
          )}
        </button>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1 text-center sm:items-start sm:text-left">
          <p className="flex items-center gap-2 text-lg font-semibold">
            {pro.fullName}
            <Badge tone="success">
              <CheckCircle2 className="mr-1 size-3" aria-hidden /> Verified
            </Badge>
          </p>
          <p className="text-sm text-muted-foreground">
            {photo
              ? 'This photo is shown to companies when you are assigned to a job.'
              : 'Add a clear photo of your face. Companies see it when you are assigned to a job.'}
          </p>
        </div>
        {photoType && (
          <div className="w-full sm:w-auto">
            <FileUpload
              accept={photoType.allowedMime}
              maxSizeBytes={photoType.maxSizeBytes}
              label={photo ? 'Change photo' : 'Add profile photo'}
              api={documentUploadApi({ typeCode: 'PHOTO', owner: { type: 'PROFESSIONAL', id: pro.id } })}
              onUploaded={() => {
                setBroken(false);
                void invalidate();
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* =============================================================== documents */

function DocumentRow({
  type,
  ownerType,
  ownerId,
  current,
  disabled,
}: {
  type: DocumentTypeView;
  ownerType: string;
  ownerId: string;
  current?: { id: string; status: string; fileName: string; review?: { comment?: string } };
  disabled: boolean;
}) {
  const invalidate = useInvalidateProvider();
  const [number, setNumber] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const needsNumber = type.captureNumber && !current;
  const needsExpiry = type.hasExpiry && !current;
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 md:w-1/2">
        <p className="flex items-center gap-2 font-medium">
          {current && current.status !== 'REJECTED' ? (
            <CheckCircle2 className="size-4 text-success" />
          ) : (
            <Circle className="size-4 text-muted-foreground" />
          )}
          {type.name}
        </p>
        {type.description && <p className="text-xs text-muted-foreground">{type.description}</p>}
        {current && (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-primary hover:underline"
              onClick={() => openDocument(current.id, current.fileName)}
            >
              <FileText className="size-3" /> {current.fileName}
            </button>
            <StatusBadge status={current.status} />
          </p>
        )}
        {current?.status === 'REJECTED' && current.review?.comment && (
          <p className="mt-1 text-xs text-destructive">Reviewer: {current.review.comment}</p>
        )}
      </div>
      {!disabled && (
        <div className="flex flex-col gap-2 md:w-1/2">
          {(type.captureNumber || type.hasExpiry) && (
            <div className="grid grid-cols-2 gap-2">
              {type.captureNumber && (
                <Input
                  placeholder="Document number"
                  aria-label={`${type.name} number`}
                  value={number}
                  onChange={(e) => setNumber(e.target.value.toUpperCase())}
                />
              )}
              {type.hasExpiry && (
                <Input
                  type="date"
                  aria-label={`${type.name} expiry date`}
                  value={expiresOn}
                  onChange={(e) => setExpiresOn(e.target.value)}
                />
              )}
            </div>
          )}
          <FileUpload
            accept={type.allowedMime}
            maxSizeBytes={type.maxSizeBytes}
            label={current ? 'Replace file' : 'Upload'}
            disabled={
              (needsNumber && !number) ||
              (needsExpiry && !expiresOn) ||
              (type.captureNumber && !number) ||
              (type.hasExpiry && !expiresOn)
            }
            api={documentUploadApi({
              typeCode: type.code,
              owner: { type: ownerType, id: ownerId },
              number: number || undefined,
              expiresOn: expiresOn || undefined,
            })}
            onUploaded={() => void invalidate()}
          />
        </div>
      )}
    </li>
  );
}

function DocumentChecklist({
  ownerType,
  ownerId,
  readiness,
  disabled,
}: {
  ownerType: 'PROFESSIONAL' | 'VENDOR';
  ownerId: string;
  readiness?: ReadinessView | null;
  disabled: boolean;
}) {
  const types = useDocumentTypes();
  const docs = useDocuments(ownerType, ownerId);
  const required = new Set((readiness?.requiredDocuments ?? []).map((d) => d.code));
  const relevant = (types.data ?? []).filter(
    (t) => t.ownerTypes.includes(ownerType) && t.code !== 'PAYMENT_PROOF',
  );
  const ordered = [
    ...relevant.filter((t) => required.has(t.code)),
    ...relevant.filter((t) => !required.has(t.code)),
  ];
  if (types.isLoading || docs.isLoading) return <Skeleton className="h-40" />;
  return (
    <>
      {!readiness?.planSelected && (
        <Alert tone="info" className="mb-3">
          Choose a plan to see which documents are mandatory.
        </Alert>
      )}
      <ul className="divide-y">
        {ordered.map((t) => (
          <div key={t.code}>
            {required.has(t.code) && (
              <Badge tone="primary" className="mt-3">
                Required
              </Badge>
            )}
            <DocumentRow
              type={t}
              ownerType={ownerType}
              ownerId={ownerId}
              current={docs.data?.find((d) => d.typeCode === t.code)}
              disabled={disabled}
            />
          </div>
        ))}
      </ul>
    </>
  );
}

/* =============================================================== plan, payment, submit */

function PlanAndPayment({
  providerType,
  registration,
  ownerId,
  editable,
}: {
  providerType: 'PROFESSIONAL' | 'VENDOR';
  registration?: RegistrationView | null;
  ownerId: string;
  editable: boolean;
}) {
  const plans = usePlans(providerType);
  const payments = useMyPayments();
  const m = useRegistrationMutations();
  const [offline, setOffline] = useState(false);
  const [method, setMethod] = useState('NEFT');
  const [reference, setReference] = useState('');
  const [bank, setBank] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [proofId, setProofId] = useState<string | null>(null);
  const paid = registration?.payment.status === 'PAID' || registration?.payment.status === 'WAIVED';
  const pendingOffline = payments.data?.find((p) => p.status === 'PENDING_VERIFICATION');
  const error = (m.selectPlan.error ?? m.payOnline.error ?? m.offline.error) as ApiError | null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 md:grid-cols-2">
        {plans.data?.map((p) => {
          const selected = registration?.plan?.code === p.code;
          return (
            <button
              key={p.code}
              type="button"
              disabled={!editable || paid || m.selectPlan.isPending}
              onClick={() => m.selectPlan.mutate(p.code)}
              className={cn(
                'flex flex-col gap-2 rounded-2xl border p-4 text-left transition-colors disabled:cursor-default',
                selected ? 'border-primary bg-accent' : 'hover:bg-muted',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-semibold">{p.name}</span>
                {selected && <Badge tone="primary">Selected</Badge>}
              </span>
              <span className="text-2xl font-bold tabular">{formatMoney(p.totalPaise)}</span>
              <span className="text-xs text-muted-foreground">
                {formatMoney(p.feePaise)} + {p.gstRateBp / 100}% GST · one-time
                {p.maxWorkers
                  ? ` · up to ${p.maxWorkers} workers`
                  : providerType === 'VENDOR'
                    ? ' · unlimited workers'
                    : ''}
              </span>
              <ul className="mt-1 space-y-1 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> {f}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      {registration?.plan && !paid && (
        <div className="flex flex-col gap-3 rounded-2xl border p-4">
          <p className="font-semibold">Pay {formatMoney(registration.plan.totalPaise)}</p>
          {pendingOffline ? (
            <Alert tone="info">
              Your {humanize(pendingOffline.method ?? 'offline')} payment (ref{' '}
              {pendingOffline.offline?.reference}) is being verified by our finance team.
            </Alert>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button loading={m.payOnline.isPending} onClick={() => m.payOnline.mutate()}>
                  Pay online
                </Button>
                {registration.plan.offlinePaymentAllowed && (
                  <Button variant="outline" onClick={() => setOffline((o) => !o)}>
                    I paid by bank transfer or cheque
                  </Button>
                )}
              </div>
              {offline && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="off-method">Method</Label>
                    <Select id="off-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                      {OFFLINE_METHODS.filter((x) => x !== 'CASH').map((x) => (
                        <option key={x} value={x}>
                          {humanize(x)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="off-ref">UTR / cheque / transaction number</Label>
                    <Input id="off-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="off-bank">Bank</Label>
                    <Input id="off-bank" value={bank} onChange={(e) => setBank(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="off-date">Paid on</Label>
                    <Input
                      id="off-date"
                      type="date"
                      value={paidOn}
                      onChange={(e) => setPaidOn(e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <FileUpload
                      accept={['application/pdf', 'image/jpeg', 'image/png']}
                      maxSizeBytes={5 * 1024 * 1024}
                      label="Upload payment proof"
                      api={documentUploadApi({
                        typeCode: 'PAYMENT_PROOF',
                        owner: { type: providerType, id: ownerId },
                      })}
                      onUploaded={(id) => setProofId(id)}
                    />
                  </div>
                  <Button
                    className="sm:col-span-2"
                    disabled={!proofId || reference.length < 4 || !paidOn}
                    loading={m.offline.isPending}
                    onClick={() =>
                      proofId &&
                      m.offline.mutate({
                        method: method as (typeof OFFLINE_METHODS)[number],
                        reference,
                        ...(bank ? { bank } : {}),
                        paidOn,
                        proofDocId: proofId,
                      })
                    }
                  >
                    Submit payment details
                  </Button>
                </div>
              )}
            </>
          )}
          {m.payOnline.data === 'paid' && (
            <Alert tone="success">Payment received. Confirmation may take a few seconds.</Alert>
          )}
        </div>
      )}
      {paid && (
        <Alert tone="success">
          Registration fee{' '}
          {registration?.payment.status === 'WAIVED'
            ? 'waived'
            : `paid (${formatMoney(registration?.payment.paidPaise)})`}
          .
        </Alert>
      )}
      {error && <Alert>{error.message}</Alert>}
    </div>
  );
}

function SubmitPanel({ readiness, status }: { readiness?: ReadinessView | null; status: ProviderStatus }) {
  const m = useRegistrationMutations();
  const err = m.submit.error as ApiError | null;
  if (!['DRAFT', 'CHANGES_REQUESTED'].includes(status)) return <Alert tone="success">Submitted.</Alert>;
  return (
    <div className="flex flex-col gap-3">
      {readiness && !readiness.canSubmit && (
        <ul className="space-y-1 text-sm">
          {!readiness.planSelected && (
            <li className="flex gap-2">
              <Circle className="mt-0.5 size-4" /> Choose a plan
            </li>
          )}
          {readiness.missingProfile.map((m2) => (
            <li key={m2} className="flex gap-2">
              <Circle className="mt-0.5 size-4" /> {m2}
            </li>
          ))}
          {readiness.missingDocuments.map((d) => (
            <li key={d.code} className="flex gap-2">
              <Circle className="mt-0.5 size-4" /> Upload: {d.name}
            </li>
          ))}
        </ul>
      )}
      <Button
        size="lg"
        disabled={!readiness?.canSubmit}
        loading={m.submit.isPending}
        onClick={() => m.submit.mutate()}
      >
        Submit for verification
      </Button>
      {err && (
        <Alert>
          {err.message}
          {err.details.length ? `: ${err.details.map((d) => d.message ?? d.field).join(', ')}` : ''}
        </Alert>
      )}
    </div>
  );
}

/* =============================================================== professional */

const proFormSchema = professionalProfileSchema;
type ProForm = z.input<typeof proFormSchema>;

function ProfessionalProfileForm({ pro, disabled }: { pro: ProfessionalView; disabled: boolean }) {
  const { update } = useProfessionalMutations();
  const categories = useCategories();
  const form = useForm<ProForm>({
    resolver: zodResolver(proFormSchema),
    defaultValues: {
      fullName: pro.fullName,
      dob: pro.dob ?? '',
      gender: (pro.gender as ProForm['gender']) ?? 'UNDISCLOSED',
      address: pro.address ?? { line1: '', city: '', state: '', pincode: '', country: 'IN' },
      serviceLocation: pro.serviceLocation ?? { lat: 0, lng: 0 },
      radiusKm: pro.radiusKm ?? 15,
      languages: pro.languages.length ? pro.languages : ['Hindi'],
      experienceYears: pro.experienceYears ?? 0,
      categoryIds: pro.categoryIds,
      identity: { idType: pro.identity?.idType ?? 'PAN', idNumber: '' },
    },
  });
  const [langText, setLangText] = useState(pro.languages.join(', ') || 'Hindi');
  const locked = !!pro.identity && pro.status !== 'DRAFT';

  const submit = form.handleSubmit((values) =>
    update.mutate((locked ? { ...values, identity: undefined } : values) as ProfessionalUpdateInput, {
      onError: (e) => applyServerErrors(e, form.setError),
    }),
  );

  const locate = () =>
    navigator.geolocation?.getCurrentPosition((pos) => {
      form.setValue('serviceLocation', {
        lat: Number(pos.coords.latitude.toFixed(5)),
        lng: Number(pos.coords.longitude.toFixed(5)),
      });
    });

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit} noValidate>
      <FormField
        control={form.control}
        name="fullName"
        label="Full name"
        required
        render={(f, a) => <Input {...a} {...f} disabled={disabled} />}
      />
      <FormField
        control={form.control}
        name="dob"
        label="Date of birth"
        required
        render={(f, a) => <Input {...a} {...f} type="date" disabled={disabled} />}
      />
      <FormField
        control={form.control}
        name="address.line1"
        label="Address"
        required
        className="sm:col-span-2"
        render={(f, a) => <Input {...a} {...f} disabled={disabled} />}
      />
      <FormField
        control={form.control}
        name="address.city"
        label="City"
        required
        render={(f, a) => <Input {...a} {...f} disabled={disabled} />}
      />
      <FormField
        control={form.control}
        name="address.state"
        label="State"
        required
        render={(f, a) => <Input {...a} {...f} disabled={disabled} />}
      />
      <FormField
        control={form.control}
        name="address.pincode"
        label="Pincode"
        required
        render={(f, a) => <Input {...a} {...f} inputMode="numeric" disabled={disabled} />}
      />
      <FormField
        control={form.control}
        name="experienceYears"
        label="Years of experience"
        required
        render={(f, a) => (
          <Input
            {...a}
            type="number"
            min={0}
            value={f.value}
            onChange={(e) => f.onChange(Number(e.target.value))}
            disabled={disabled}
          />
        )}
      />
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label>Work location</Label>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Input
            type="number"
            step="0.00001"
            aria-label="Latitude"
            value={form.watch('serviceLocation.lat')}
            onChange={(e) => form.setValue('serviceLocation.lat', Number(e.target.value))}
            disabled={disabled}
          />
          <Input
            type="number"
            step="0.00001"
            aria-label="Longitude"
            value={form.watch('serviceLocation.lng')}
            onChange={(e) => form.setValue('serviceLocation.lng', Number(e.target.value))}
            disabled={disabled}
          />
          <Button
            type="button"
            variant="outline"
            onClick={locate}
            disabled={disabled}
            aria-label="Use my current location"
          >
            <LocateFixed />
          </Button>
        </div>
      </div>
      <FormField
        control={form.control}
        name="radiusKm"
        label="How far will you travel? (km)"
        required
        render={(f, a) => (
          <Input
            {...a}
            type="number"
            min={1}
            max={200}
            value={f.value}
            onChange={(e) => f.onChange(Number(e.target.value))}
            disabled={disabled}
          />
        )}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="langs">Languages (comma separated)</Label>
        <Input
          id="langs"
          value={langText}
          disabled={disabled}
          onChange={(e) => {
            setLangText(e.target.value);
            form.setValue(
              'languages',
              e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length >= 2),
            );
          }}
        />
      </div>
      <FormField
        control={form.control}
        name="categoryIds"
        label="Service categories"
        className="sm:col-span-2"
        render={(f) => (
          <div className="flex flex-wrap gap-2">
            {(categories.data ?? [])
              .filter((c) => c.level === 1)
              .map((c) => {
                const on = f.value?.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      f.onChange(on ? f.value?.filter((x) => x !== c.id) : [...(f.value ?? []), c.id])
                    }
                    className={cn(
                      'rounded-full border px-3 py-1 text-sm',
                      on ? 'border-primary bg-accent text-accent-foreground' : 'hover:bg-muted',
                    )}
                  >
                    {c.name}
                  </button>
                );
              })}
          </div>
        )}
      />
      <FormField
        control={form.control}
        name="identity.idType"
        label="Government ID"
        required
        hint={
          pro.identity
            ? `On file: ${humanize(pro.identity.idType)} ending ${pro.identity.idLast4}`
            : 'Your ID number is encrypted. Aadhaar numbers are never stored, only a fingerprint.'
        }
        render={(f, a) => (
          <Select {...a} value={f.value} onChange={f.onChange} disabled={disabled || locked}>
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
        required={!locked}
        render={(f, a) => (
          <Input
            {...a}
            {...f}
            disabled={disabled || locked}
            placeholder={pro.identity ? `•••• ${pro.identity.idLast4}` : ''}
          />
        )}
      />
      {!disabled && (
        <Button type="submit" className="sm:col-span-2" loading={update.isPending}>
          Save profile
        </Button>
      )}
      {update.isSuccess && (
        <Alert tone="success" className="sm:col-span-2">
          Profile saved.
        </Alert>
      )}
    </form>
  );
}

function SkillsEditor({ pro, disabled }: { pro: ProfessionalView; disabled: boolean }) {
  const skills = useSkills();
  const { skills: save } = useProfessionalMutations();
  const [rows, setRows] = useState(
    pro.skills.map((s) => ({ skillId: s.skillId, proficiency: s.proficiency as string, years: s.years })),
  );
  const used = new Set(rows.map((r) => r.skillId));
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
          <Select
            aria-label="Skill"
            value={r.skillId}
            disabled={disabled}
            onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, skillId: e.target.value } : x)))}
          >
            <option value="">Choose a skill…</option>
            {skills.data
              ?.filter((s) => s.id === r.skillId || !used.has(s.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
          <Select
            aria-label="Proficiency"
            value={r.proficiency}
            disabled={disabled}
            onChange={(e) =>
              setRows(rows.map((x, j) => (j === i ? { ...x, proficiency: e.target.value } : x)))
            }
          >
            {PROFICIENCIES.map((p) => (
              <option key={p} value={p}>
                {humanize(p)}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Years"
            type="number"
            min={0}
            className="w-20"
            value={r.years}
            disabled={disabled}
            onChange={(e) =>
              setRows(rows.map((x, j) => (j === i ? { ...x, years: Number(e.target.value) } : x)))
            }
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove skill"
            disabled={disabled}
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      {pro.skills.some((s) => s.verification === 'VERIFIED') && (
        <p className="text-xs text-muted-foreground">Changed skills need to be verified again.</p>
      )}
      {!disabled && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setRows([...rows, { skillId: '', proficiency: 'INTERMEDIATE', years: 1 }])}
          >
            <Plus /> Add skill
          </Button>
          <Button
            loading={save.isPending}
            disabled={rows.length === 0 || rows.some((r) => !r.skillId)}
            onClick={() => save.mutate(rows)}
          >
            Save skills
          </Button>
        </div>
      )}
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
    </div>
  );
}

function ProfessionalOnboarding() {
  const pro = useMyProfessional();
  const registration = useRegistration(!!pro.data);
  const readiness = useReadiness(!!pro.data);
  const { create } = useProfessionalMutations();
  if (pro.isLoading) return <Skeleton className="h-64" />;
  if (!pro.data) {
    return (
      <EmptyState
        title="Start your professional profile"
        description="It takes about 10 minutes. Keep your ID, a photo and your certificates handy."
        action={
          <Button loading={create.isPending} onClick={() => create.mutate()}>
            Start
          </Button>
        }
      />
    );
  }
  const p = pro.data;
  const editable = EDITABLE.includes(p.status);
  return (
    <div className="flex flex-col gap-6">
      {p.status === 'APPROVED' && <ProfilePhotoCard pro={p} />}
      <StatusBanner status={p.status} registration={registration.data} />
      <Section
        step={1}
        title="Your details"
        done={p.completion.missing.filter((m) => m !== 'Skills').length === 0}
      >
        <ProfessionalProfileForm
          key={p.id + p.status}
          pro={p}
          disabled={!editable && p.status !== 'APPROVED'}
        />
      </Section>
      <Section
        step={2}
        title="Skills"
        description="Add each skill you want to be invited for."
        done={p.skills.length > 0}
      >
        <SkillsEditor pro={p} disabled={!editable && p.status !== 'APPROVED'} />
      </Section>
      <Section
        step={3}
        title="Plan and registration fee"
        done={registration.data?.payment.status === 'PAID' || registration.data?.payment.status === 'WAIVED'}
      >
        <PlanAndPayment
          providerType="PROFESSIONAL"
          registration={registration.data}
          ownerId={p.id}
          editable={editable}
        />
      </Section>
      <Section
        step={4}
        title="Documents"
        done={!!readiness.data?.planSelected && readiness.data.missingDocuments.length === 0}
      >
        <DocumentChecklist
          ownerType="PROFESSIONAL"
          ownerId={p.id}
          readiness={readiness.data}
          disabled={!editable && p.status !== 'APPROVED'}
        />
      </Section>
      <Section
        step={5}
        title="Submit for verification"
        done={!EDITABLE.includes(p.status) || p.status === 'PENDING_PAYMENT'}
      >
        <SubmitPanel readiness={readiness.data} status={p.status} />
      </Section>
    </div>
  );
}

/* =============================================================== vendor */

function VendorCreateForm() {
  const { refreshUser } = useAuth();
  const { create } = useVendorMutations(refreshUser);
  const form = useForm<VendorCreateInput>({
    resolver: zodResolver(vendorCreateSchema),
    defaultValues: {
      legalName: '',
      entityType: 'PVT_LTD',
      pan: '',
      registeredAddress: { line1: '', city: '', state: '', pincode: '', country: 'IN' },
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Register your business</CardTitle>
        <CardDescription>One registration covers onboarding all your workers.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={form.handleSubmit((v) =>
            create.mutate(v, { onError: (e) => applyServerErrors(e, form.setError) }),
          )}
          noValidate
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
            name="tradeName"
            label="Trade name"
            render={(f, a) => <Input {...a} {...f} value={f.value ?? ''} />}
          />
          <FormField
            control={form.control}
            name="entityType"
            label="Entity type"
            required
            render={(f, a) => (
              <Select {...a} value={f.value} onChange={f.onChange}>
                {ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </Select>
            )}
          />
          <FormField
            control={form.control}
            name="pan"
            label="Business PAN"
            required
            render={(f, a) => (
              <Input {...a} {...f} onChange={(e) => f.onChange(e.target.value.toUpperCase())} />
            )}
          />
          <FormField
            control={form.control}
            name="gstin"
            label="GSTIN"
            render={(f, a) => (
              <Input
                {...a}
                {...f}
                value={f.value ?? ''}
                onChange={(e) => f.onChange(e.target.value.toUpperCase() || undefined)}
              />
            )}
          />
          <FormField
            control={form.control}
            name="registeredAddress.line1"
            label="Registered address"
            required
            className="sm:col-span-2"
            render={(f, a) => <Input {...a} {...f} />}
          />
          <FormField
            control={form.control}
            name="registeredAddress.city"
            label="City"
            required
            render={(f, a) => <Input {...a} {...f} />}
          />
          <FormField
            control={form.control}
            name="registeredAddress.state"
            label="State"
            required
            render={(f, a) => <Input {...a} {...f} />}
          />
          <FormField
            control={form.control}
            name="registeredAddress.pincode"
            label="Pincode"
            required
            render={(f, a) => <Input {...a} {...f} />}
          />
          <Button type="submit" className="sm:col-span-2" loading={create.isPending}>
            Create vendor profile
          </Button>
          {create.error && !(create.error as ApiError).details.length && (
            <Alert className="sm:col-span-2">{(create.error as ApiError).message}</Alert>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function VendorDetailsForm({ vendor, disabled }: { vendor: VendorView; disabled: boolean }) {
  const { update } = useVendorMutations();
  const categories = useCategories();
  const [cats, setCats] = useState<string[]>(vendor.categoryIds);
  const [loc, setLoc] = useState(
    vendor.operatingLocations[0] ?? { label: 'Head office', lat: 0, lng: 0, radiusKm: 50 },
  );
  const [contact, setContact] = useState(vendor.contacts[0] ?? { name: '', mobile: '', designation: '' });
  const [gstin, setGstin] = useState(vendor.gstin ?? '');
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label>Service categories</Label>
        <div className="flex flex-wrap gap-2">
          {(categories.data ?? [])
            .filter((c) => c.level === 1)
            .map((c) => {
              const on = cats.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => setCats(on ? cats.filter((x) => x !== c.id) : [...cats, c.id])}
                  className={cn(
                    'rounded-full border px-3 py-1 text-sm',
                    on ? 'border-primary bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  {c.name}
                </button>
              );
            })}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="loc-label">Operating location</Label>
        <Input
          id="loc-label"
          value={loc.label}
          disabled={disabled}
          onChange={(e) => setLoc({ ...loc, label: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loc-lat">Latitude</Label>
          <Input
            id="loc-lat"
            type="number"
            step="0.00001"
            value={loc.lat}
            disabled={disabled}
            onChange={(e) => setLoc({ ...loc, lat: Number(e.target.value) })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loc-lng">Longitude</Label>
          <Input
            id="loc-lng"
            type="number"
            step="0.00001"
            value={loc.lng}
            disabled={disabled}
            onChange={(e) => setLoc({ ...loc, lng: Number(e.target.value) })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="loc-r">Radius km</Label>
          <Input
            id="loc-r"
            type="number"
            value={loc.radiusKm}
            disabled={disabled}
            onChange={(e) => setLoc({ ...loc, radiusKm: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="c-name">Contact person</Label>
        <Input
          id="c-name"
          value={contact.name}
          disabled={disabled}
          onChange={(e) => setContact({ ...contact, name: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="c-mobile">Contact mobile (+91…)</Label>
        <Input
          id="c-mobile"
          value={contact.mobile}
          disabled={disabled}
          onChange={(e) => setContact({ ...contact, mobile: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gstin">GSTIN</Label>
        <Input
          id="gstin"
          value={gstin}
          disabled={disabled}
          onChange={(e) => setGstin(e.target.value.toUpperCase())}
        />
      </div>
      {!disabled && (
        <Button
          className="sm:col-span-2"
          loading={update.isPending}
          onClick={() =>
            update.mutate({
              categoryIds: cats,
              operatingLocations: [loc],
              contacts: [{ name: contact.name, mobile: contact.mobile }],
              ...(gstin ? { gstin } : {}),
            })
          }
        >
          Save details
        </Button>
      )}
      {update.error && (
        <Alert className="sm:col-span-2">
          {(update.error as ApiError).message}
          {(update.error as ApiError).details.length
            ? ` (${(update.error as ApiError).details.map((d) => d.path).join(', ')})`
            : ''}
        </Alert>
      )}
      {update.isSuccess && (
        <Alert tone="success" className="sm:col-span-2">
          Details saved.
        </Alert>
      )}
    </div>
  );
}

function VendorOnboarding() {
  const vendor = useMyVendor();
  const registration = useRegistration(!!vendor.data);
  const readiness = useReadiness(!!vendor.data);
  if (vendor.isLoading) return <Skeleton className="h-64" />;
  if (!vendor.data) return <VendorCreateForm />;
  const v = vendor.data;
  const editable = EDITABLE.includes(v.status);
  return (
    <div className="flex flex-col gap-6">
      <StatusBanner status={v.status} registration={registration.data} />
      <Section
        step={1}
        title={v.legalName}
        description={`PAN ending ${v.panLast4}`}
        done={v.completion.missing.length === 0}
      >
        <VendorDetailsForm key={v.id + v.status} vendor={v} disabled={!editable && v.status !== 'APPROVED'} />
      </Section>
      <Section
        step={2}
        title="Plan and registration fee"
        done={registration.data?.payment.status === 'PAID' || registration.data?.payment.status === 'WAIVED'}
      >
        <PlanAndPayment
          providerType="VENDOR"
          registration={registration.data}
          ownerId={v.id}
          editable={editable}
        />
      </Section>
      <Section
        step={3}
        title="Business documents"
        done={!!readiness.data?.planSelected && readiness.data.missingDocuments.length === 0}
      >
        <DocumentChecklist
          ownerType="VENDOR"
          ownerId={v.id}
          readiness={readiness.data}
          disabled={!editable && v.status !== 'APPROVED'}
        />
      </Section>
      <Section
        step={4}
        title="Submit for verification"
        done={!EDITABLE.includes(v.status) || v.status === 'PENDING_PAYMENT'}
      >
        <SubmitPanel readiness={readiness.data} status={v.status} />
      </Section>
    </div>
  );
}

export function OnboardingPage() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader
        title="Registration"
        description="Get verified to start receiving work through BijliWala360."
      />
      {user?.userType === 'VENDOR' ? <VendorOnboarding /> : <ProfessionalOnboarding />}
    </>
  );
}
