import {
  AlertTriangle,
  Briefcase,
  Building2,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  FilePen,
  FileSignature,
  HardHat,
  RotateCcw,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { WorkQueueItem, WorkQueueKey } from '@bijliwala/contracts';
import { PageHeader } from '@/components/layout/page-parts';
import { Alert, Card, CardContent, Skeleton } from '@/components/ui/primitives';
import { useWorkQueue } from '@/features/admin/dashboard-api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

interface QueueMeta {
  label: string;
  hint: string;
  to: string;
  icon: LucideIcon;
  group: 'Providers' | 'Finance' | 'Clients and work';
}

/** Presentation for each queue; the link opens the admin list filtered to the waiting items. */
const QUEUES: Record<WorkQueueKey, QueueMeta> = {
  REGISTRATIONS_TO_VERIFY: {
    label: 'Registrations to verify',
    hint: 'Submitted and paid, waiting for a decision',
    to: '/admin/verification',
    icon: ShieldCheck,
    group: 'Providers',
  },
  DOCUMENTS_TO_REVIEW: {
    label: 'Documents to review',
    hint: 'Uploaded and not yet verified or rejected',
    to: '/admin/verification',
    icon: FileCheck2,
    group: 'Providers',
  },
  WORKERS_TO_VERIFY: {
    label: 'Vendor workers to verify',
    hint: 'Added by vendors, waiting for checks',
    to: '/admin/verification?tab=workers',
    icon: HardHat,
    group: 'Providers',
  },
  IDENTITY_CONFLICTS: {
    label: 'Identity conflicts',
    hint: 'The same ID number on more than one person',
    to: '/admin/verification?tab=conflicts',
    icon: AlertTriangle,
    group: 'Providers',
  },
  OFFLINE_PAYMENTS_TO_VERIFY: {
    label: 'Offline payments to verify',
    hint: 'Bank transfers and cheques with proof attached',
    to: '/admin/finance',
    icon: Wallet,
    group: 'Finance',
  },
  REFUNDS_TO_APPROVE: {
    label: 'Refunds to approve',
    hint: 'Requested and waiting for an approver',
    to: '/admin/finance?tab=refunds',
    icon: RotateCcw,
    group: 'Finance',
  },
  COMPANIES_TO_ACTIVATE: {
    label: 'Companies to activate',
    hint: 'Registered and waiting for verification',
    to: '/admin/companies?status=PENDING_VERIFICATION',
    icon: Building2,
    group: 'Clients and work',
  },
  NEW_ENQUIRIES: {
    label: 'New enquiries',
    hint: 'Not yet picked up by the team',
    to: '/admin/enquiries?status=NEW',
    icon: ClipboardList,
    group: 'Clients and work',
  },
  DRAFT_QUOTATIONS: {
    label: 'Draft quotations',
    hint: 'Prepared but not sent to the client',
    to: '/admin/enquiries?status=IN_REVIEW',
    icon: FilePen,
    group: 'Clients and work',
  },
  QUOTATIONS_AWAITING_CLIENT: {
    label: 'Quotations awaiting client',
    hint: 'Sent and waiting for acceptance',
    to: '/admin/enquiries?status=QUOTED',
    icon: FileSignature,
    group: 'Clients and work',
  },
  JOBS_TO_STAFF: {
    label: 'Jobs to staff',
    hint: 'Open, matching or partly staffed',
    to: '/admin/jobs',
    icon: Briefcase,
    group: 'Clients and work',
  },
};

const GROUPS: QueueMeta['group'][] = ['Providers', 'Finance', 'Clients and work'];

function waitingFor(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'Oldest: today';
  return days === 1 ? 'Oldest: 1 day' : `Oldest: ${days} days`;
}

function QueueTile({ item }: { item: WorkQueueItem }) {
  const meta = QUEUES[item.key];
  const Icon = meta.icon;
  const waiting = item.count > 0;
  return (
    <Link
      to={meta.to}
      className="group rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${meta.label}: ${item.count}`}
    >
      <Card className={cn('h-full transition-colors group-hover:border-primary', !waiting && 'opacity-70')}>
        <CardContent className="flex items-start gap-4 pt-5">
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl',
              waiting ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            <Icon className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-muted-foreground">{meta.label}</p>
            <p className="text-3xl font-bold tabular">{item.count}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {waiting && item.oldestAt ? (
                <span title={formatDateTime(item.oldestAt)}>{waitingFor(item.oldestAt)}</span>
              ) : waiting ? (
                meta.hint
              ) : (
                'Nothing waiting'
              )}
            </p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/** Admin home: what is waiting for this admin, grouped by area, each tile linking to the list. */
export function AdminDashboardPage() {
  const queue = useWorkQueue();
  const items = queue.data?.items ?? [];
  const total = items.reduce((sum, i) => sum + i.count, 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          queue.data
            ? `${total} item${total === 1 ? '' : 's'} waiting · updated ${formatDateTime(queue.data.generatedAt)}`
            : 'What is waiting for you'
        }
      />
      {queue.isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      )}
      {queue.isError && <Alert tone="danger">The work queue could not be loaded. Try again shortly.</Alert>}
      {queue.data && items.length === 0 && (
        <Alert tone="info">
          Your role has no work queues. Use the menu to open the sections you can access.
        </Alert>
      )}
      {queue.data && items.length > 0 && total === 0 && (
        <Alert tone="success" className="mb-6">
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="size-4" aria-hidden /> All clear. Nothing is waiting for you.
          </span>
        </Alert>
      )}
      <div className="flex flex-col gap-8">
        {GROUPS.map((group) => {
          const groupItems = items.filter((i) => QUEUES[i.key]?.group === group);
          if (groupItems.length === 0) return null;
          return (
            <section key={group} aria-labelledby={`queue-${group}`}>
              <h2
                id={`queue-${group}`}
                className="mb-3 text-sm font-semibold uppercase text-muted-foreground"
              >
                {group}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {groupItems.map((item) => (
                  <QueueTile key={item.key} item={item} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
