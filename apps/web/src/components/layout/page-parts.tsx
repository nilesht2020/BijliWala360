import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, type BadgeProps } from '@/components/ui/primitives';
import { humanize } from '@/lib/format';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground sm:text-base">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-12 text-center',
        className,
      )}
    >
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Icon className="size-6" aria-hidden />
      </div>
      <p className="font-semibold">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

type Tone = NonNullable<BadgeProps['tone']>;

/**
 * Single status -> colour mapping used for every lifecycle enum, so the same status always looks
 * the same across portals.
 */
const STATUS_TONES: Record<string, Tone> = {
  // positive / done
  APPROVED: 'success',
  ACTIVE: 'success',
  VERIFIED: 'success',
  CONFIRMED: 'success',
  COMPLETED: 'success',
  PAID: 'success',
  SUCCESS: 'success',
  CLEARED: 'success',
  PROCESSED: 'success',
  ACCEPTED: 'success',
  STAFFED: 'success',
  RESOLVED: 'success',
  RESPONDED_INTERESTED: 'success',
  UPLOADED: 'success',
  // waiting on someone
  PENDING: 'warning',
  PENDING_PAYMENT: 'warning',
  PENDING_VERIFICATION: 'warning',
  PENDING_APPROVAL: 'warning',
  PENDING_CONFIRMATION: 'warning',
  CHANGES_REQUESTED: 'warning',
  PARTIALLY_PAID: 'warning',
  PARTIALLY_STAFFED: 'warning',
  PARTIALLY_REFUNDED: 'warning',
  OVERDUE: 'danger',
  ON_HOLD: 'warning',
  SCANNING: 'info',
  // in flight
  OPEN: 'info',
  NEW: 'info',
  SENT: 'info',
  VIEWED: 'info',
  MATCHING: 'info',
  ALLOCATING: 'info',
  IN_PROGRESS: 'info',
  IN_REVIEW: 'info',
  PROCESSING: 'info',
  ISSUED: 'info',
  QUOTED: 'info',
  DEPOSITED: 'info',
  RECEIVED: 'info',
  HELD: 'info',
  REOPENED: 'warning',
  // negative
  REJECTED: 'danger',
  FAILED: 'danger',
  BOUNCED: 'danger',
  SUSPENDED: 'danger',
  NO_SHOW: 'danger',
  REJECTED_MALWARE: 'danger',
  REJECTED_TYPE: 'danger',
  // closed / neutral
  DRAFT: 'neutral',
  CANCELLED: 'neutral',
  WITHDRAWN: 'neutral',
  EXPIRED: 'neutral',
  SUPERSEDED: 'neutral',
  REPLACED: 'neutral',
  RELEASED: 'neutral',
  DEACTIVATED: 'neutral',
  INACTIVE: 'neutral',
  CLOSED: 'neutral',
  VOID: 'neutral',
  REFUNDED: 'neutral',
  RESPONDED_DECLINED: 'neutral',
};

export function statusTone(status: string): Tone {
  return STATUS_TONES[status] ?? 'neutral';
}

export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string;
  label?: string;
  className?: string;
}) {
  return (
    <Badge tone={statusTone(status)} className={className} data-status={status}>
      {label ?? humanize(status)}
    </Badge>
  );
}
