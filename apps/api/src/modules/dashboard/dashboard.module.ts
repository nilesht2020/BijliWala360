import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Connection } from 'mongoose';
import type { Permission, WorkQueueItem, WorkQueueKey, WorkQueueView } from '@bijliwala/contracts';
import { CurrentUser, PlatformOnly } from '../../core/auth/decorators';
import type { AuthUser } from '../../core/auth/auth.types';

/**
 * One admin work queue: what is waiting, who may act on it, and when the item entered the queue.
 * Each entry mirrors the default filter of the admin page the dashboard tile links to.
 */
interface QueueDef {
  key: WorkQueueKey;
  permission: Permission;
  collection: string;
  filter: Record<string, unknown>;
  /** Field holding the time the item started waiting (for "oldest waiting"). */
  since: string;
}

export const WORK_QUEUES: QueueDef[] = [
  {
    key: 'REGISTRATIONS_TO_VERIFY',
    permission: 'registration.verify',
    collection: 'provider_registrations',
    filter: { 'verification.status': 'PENDING' },
    since: 'verification.submittedAt',
  },
  {
    key: 'DOCUMENTS_TO_REVIEW',
    permission: 'document.verify',
    collection: 'documents',
    filter: { status: 'UPLOADED', typeCode: { $ne: 'PAYMENT_PROOF' } },
    since: 'updatedAt',
  },
  {
    key: 'WORKERS_TO_VERIFY',
    permission: 'registration.verify',
    collection: 'vendor_workers',
    filter: { status: 'PENDING_VERIFICATION' },
    since: 'createdAt',
  },
  {
    key: 'IDENTITY_CONFLICTS',
    permission: 'identity.resolve',
    collection: 'identity_conflicts',
    filter: { status: 'OPEN' },
    since: 'createdAt',
  },
  {
    key: 'OFFLINE_PAYMENTS_TO_VERIFY',
    permission: 'payment.verify',
    collection: 'registration_payments',
    filter: { mode: 'OFFLINE', status: 'PENDING_VERIFICATION' },
    since: 'createdAt',
  },
  {
    key: 'REFUNDS_TO_APPROVE',
    permission: 'refund.approve',
    collection: 'registration_refunds',
    filter: { status: 'PENDING_APPROVAL' },
    since: 'createdAt',
  },
  {
    key: 'COMPANIES_TO_ACTIVATE',
    permission: 'company.activate',
    collection: 'companies',
    filter: { status: 'PENDING_VERIFICATION' },
    since: 'createdAt',
  },
  {
    key: 'NEW_ENQUIRIES',
    permission: 'enquiry.manage',
    collection: 'enquiries',
    filter: { status: 'NEW' },
    since: 'createdAt',
  },
  {
    key: 'DRAFT_QUOTATIONS',
    permission: 'quotation.manage',
    collection: 'quotations',
    filter: { status: 'DRAFT', isLatest: true },
    since: 'createdAt',
  },
  {
    key: 'QUOTATIONS_AWAITING_CLIENT',
    permission: 'quotation.manage',
    collection: 'quotations',
    filter: { status: 'SENT', isLatest: true },
    since: 'updatedAt',
  },
  {
    key: 'JOBS_TO_STAFF',
    permission: 'job.read',
    collection: 'jobs',
    filter: { status: { $in: ['OPEN', 'MATCHING', 'ALLOCATING', 'PARTIALLY_STAFFED'] } },
    since: 'createdAt',
  },
];

@Injectable()
export class DashboardService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Counts for the queues the user may act on (read-only; no audit needed). */
  async workQueue(user: AuthUser): Promise<WorkQueueView> {
    const visible = WORK_QUEUES.filter((q) => user.permissions.has(q.permission));
    const items = await Promise.all(visible.map((q) => this.count(q)));
    return { items, generatedAt: new Date().toISOString() };
  }

  private async count(q: QueueDef): Promise<WorkQueueItem> {
    const col = this.connection.collection(q.collection);
    const [count, oldest] = await Promise.all([
      col.countDocuments(q.filter),
      col
        .find(q.filter, { projection: { [q.since]: 1 } })
        .sort({ [q.since]: 1 })
        .limit(1)
        .next(),
    ]);
    const since = q.since.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], oldest);
    return {
      key: q.key,
      count,
      ...(count > 0 && since instanceof Date ? { oldestAt: since.toISOString() } : {}),
    };
  }
}

@ApiTags('admin-dashboard')
@Controller('admin/dashboard')
@PlatformOnly()
export class AdminDashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('work-queue')
  workQueue(@CurrentUser() user: AuthUser): Promise<WorkQueueView> {
    return this.dashboard.workQueue(user);
  }
}

@Module({ controllers: [AdminDashboardController], providers: [DashboardService] })
export class DashboardModule {}
