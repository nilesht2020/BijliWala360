import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type Model } from 'mongoose';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type CursorMeta,
  type InboxItem,
  type NotificationChannel,
  type NotificationPreferences,
  type NotificationPriority,
  type NotificationRequestPayload,
} from '@bijliwala/contracts';
import { BusinessConfigService } from '../../core/business-config/business-config.service';
import {
  EMAIL_PROVIDER,
  SMS_PROVIDER,
  WHATSAPP_PROVIDER,
  type EmailProvider,
  type SmsProvider,
  type WhatsAppProvider,
} from '../../core/channels/channels';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { DomainEventBus } from '../../core/outbox/event-bus';
import { OutboxService, type PublishedEvent } from '../../core/outbox/outbox.service';
import { QUEUES, QueueRegistry } from '../../core/queue/queue.registry';
import { UsersService } from '../users/users.service';
import type { UserDoc } from '../users/schemas';
import { quietHoursDelayMs } from './domain/quiet-hours';
import {
  NOTIFICATION_MODEL,
  NOTIFICATION_PREFERENCE_MODEL,
  type NotificationDoc,
  type NotificationPreferenceDoc,
} from './schemas';
import { renderMessage, TemplatesService } from './templates.service';

export const NOTIFICATION_REQUESTED = 'notification.requested';
const CONSUMER = 'notifications';
type ExternalChannel = Exclude<NotificationChannel, 'IN_APP'>;

export interface DeliveryJob {
  eventId: string;
  userId: string;
  eventType: string;
  priority: NotificationPriority;
  data: Record<string, unknown>;
  channels: ExternalChannel[];
}

export type DeliveryOutcome = { channel: ExternalChannel; providerMessageId: string } | { channel: null };

function encodeCursor(doc: { createdAt: Date; _id: Types.ObjectId }): string {
  return Buffer.from(`${doc.createdAt.toISOString()}|${doc._id.toHexString()}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: Types.ObjectId } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!iso || !id || !Types.ObjectId.isValid(id) || Number.isNaN(Date.parse(iso))) return null;
  return { createdAt: new Date(iso), id: new Types.ObjectId(id) };
}

/**
 * Event-driven notifications (SRS §8.1):
 *  1. A business transaction calls `request(payload, session)` -> outbox `notification.requested`.
 *  2. The worker consumes it: writes the in-app inbox entry and enqueues one delivery job per
 *     recipient (delayed through quiet hours for NORMAL priority).
 *  3. `deliver()` tries external channels in priority order and stops at the first success
 *     (fallback, FR-NTF-02); every attempt is recorded once per (event, user, channel).
 * Preferences and mutes apply to NORMAL priority only; CRITICAL always goes out (FR-NTF-05).
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(NOTIFICATION_MODEL) private readonly notifications: Model<NotificationDoc>,
    @InjectModel(NOTIFICATION_PREFERENCE_MODEL)
    private readonly preferences: Model<NotificationPreferenceDoc>,
    private readonly templates: TemplatesService,
    private readonly users: UsersService,
    private readonly outbox: OutboxService,
    private readonly bus: DomainEventBus,
    private readonly queues: QueueRegistry,
    private readonly config: BusinessConfigService,
    private readonly txn: TransactionRunner,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(NOTIFICATION_REQUESTED, CONSUMER, (event) => this.handleRequested(event));
  }

  /** Request a notification as part of the caller's transaction (transactional outbox). */
  async request(payload: NotificationRequestPayload, session: ClientSession): Promise<void> {
    if (payload.recipients.length === 0) return;
    await this.outbox.add(
      {
        type: NOTIFICATION_REQUESTED,
        aggregateType: 'Notification',
        aggregateId: payload.eventType,
        payload: { ...payload },
      },
      session,
    );
  }

  /** Convenience for callers without an open transaction. */
  async requestNow(payload: NotificationRequestPayload): Promise<void> {
    await this.txn.run((session) => this.request(payload, session));
  }

  /* ------------------------------------------------------------------ worker side */

  async handleRequested(event: PublishedEvent): Promise<void> {
    const payload = event.payload as unknown as NotificationRequestPayload;
    const channels = await this.channelOrder(payload.channels);
    const quiet = await this.config.get('notification.quietHours');
    const delay = payload.priority === 'NORMAL' ? quietHoursDelayMs(new Date(), quiet) : 0;

    for (const { userId } of payload.recipients) {
      const user = await this.users.findById(userId);
      if (!user || user.status !== 'ACTIVE') continue;
      await this.writeInApp(event.eventId, user, payload);
      if (channels.length === 0) continue;
      const job: DeliveryJob = {
        eventId: event.eventId,
        userId,
        eventType: payload.eventType,
        priority: payload.priority,
        data: payload.data,
        channels,
      };
      await this.queues.add(QUEUES.NOTIFICATIONS, payload.eventType, job, {
        jobId: `${event.eventId}:${userId}`,
        ...(delay > 0 ? { delay } : {}),
      });
    }
  }

  private async channelOrder(explicit?: NotificationChannel[]): Promise<ExternalChannel[]> {
    const order = explicit ?? (await this.config.get('notification.channelPriority'));
    return order.filter((c): c is ExternalChannel => c !== 'IN_APP');
  }

  private async writeInApp(
    eventId: string,
    user: UserDoc,
    payload: NotificationRequestPayload,
  ): Promise<void> {
    const template = await this.templates.find(payload.eventType, 'IN_APP', user.userType);
    if (!template) return;
    const rendered = renderMessage(template, payload.data);
    await this.notifications.updateOne(
      { eventId, userId: user._id, channel: 'IN_APP' },
      {
        $setOnInsert: {
          eventType: payload.eventType,
          priority: payload.priority,
          rendered: { title: rendered.title, body: rendered.body, link: rendered.link },
          status: 'DELIVERED',
          attempts: 1,
          sentAt: new Date(),
          deliveredAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  /** Delivers through the first channel that succeeds. Throws when every attempted channel failed. */
  async deliver(job: DeliveryJob): Promise<DeliveryOutcome> {
    const user = await this.users.findById(job.userId);
    if (!user || user.status !== 'ACTIVE') return { channel: null };
    const prefs = await this.getPreferences(job.userId);
    const critical = job.priority === 'CRITICAL';
    const muted = !critical && prefs.mutedEventTypes.includes(job.eventType);
    const failures: string[] = [];

    for (const channel of job.channels) {
      const key = { eventId: job.eventId, userId: user._id, channel };
      const existing = await this.notifications.findOne(key).lean<NotificationDoc>().exec();
      if (existing && (existing.status === 'SENT' || existing.status === 'DELIVERED')) {
        return { channel, providerMessageId: existing.providerMessageId ?? '' };
      }

      const skip = async (status: NotificationDoc['status']) =>
        this.notifications.updateOne(
          key,
          { $set: { status }, $setOnInsert: { eventType: job.eventType, priority: job.priority } },
          { upsert: true },
        );

      if (muted || (!critical && !prefs.channels[channel])) {
        await skip('SKIPPED_PREF');
        continue;
      }
      const template = await this.templates.find(job.eventType, channel, user.userType);
      if (!template) {
        await skip('SKIPPED_NO_TEMPLATE');
        continue;
      }
      const to = channel === 'EMAIL' ? user.email : user.mobile;
      if (!to) {
        await skip('SKIPPED_NO_CONTACT');
        continue;
      }

      const rendered = renderMessage(template, job.data);
      try {
        const result =
          channel === 'SMS'
            ? await this.sms.send({
                to,
                body: rendered.body ?? '',
                ...(rendered.dltTemplateId ? { dltTemplateId: rendered.dltTemplateId } : {}),
              })
            : channel === 'WHATSAPP'
              ? await this.whatsapp.send({
                  to,
                  ...(rendered.whatsapp as NonNullable<typeof rendered.whatsapp>),
                })
              : await this.email.send({ to, subject: rendered.subject ?? '', html: rendered.html ?? '' });
        await this.notifications.updateOne(
          key,
          {
            $set: { status: 'SENT', providerMessageId: result.providerMessageId, sentAt: new Date() },
            $inc: { attempts: 1 },
            $unset: { lastError: 1 },
            $setOnInsert: { eventType: job.eventType, priority: job.priority },
          },
          { upsert: true },
        );
        return { channel, providerMessageId: result.providerMessageId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${channel}: ${message}`);
        await this.notifications.updateOne(
          key,
          {
            $set: { status: 'FAILED', lastError: message },
            $inc: { attempts: 1 },
            $setOnInsert: { eventType: job.eventType, priority: job.priority },
          },
          { upsert: true },
        );
        this.logger.warn(
          { eventId: job.eventId, channel, err: message },
          'Channel delivery failed; trying next channel',
        );
      }
    }

    if (failures.length > 0) throw new Error(`All channels failed: ${failures.join('; ')}`);
    return { channel: null };
  }

  /** Delivery receipts from providers (WhatsApp/SMS status webhooks). Monotonic: never downgrades. */
  async markDelivery(
    providerMessageId: string,
    status: 'DELIVERED' | 'READ' | 'FAILED',
    error?: string,
  ): Promise<boolean> {
    const allowedFrom: Record<typeof status, NotificationDoc['status'][]> = {
      DELIVERED: ['SENT'],
      READ: ['SENT', 'DELIVERED'],
      FAILED: ['SENT'],
    };
    const now = new Date();
    const res = await this.notifications.updateOne(
      { providerMessageId, status: { $in: allowedFrom[status] } },
      {
        $set: {
          status,
          ...(status === 'DELIVERED' ? { deliveredAt: now } : {}),
          ...(status === 'READ' ? { readAt: now } : {}),
          ...(error ? { lastError: error } : {}),
        },
      },
    );
    return res.modifiedCount === 1;
  }

  /* ------------------------------------------------------------------ inbox (FR-NTF-01) */

  async inbox(
    userId: string,
    cursor: string | undefined,
    limit: number,
    unreadOnly: boolean,
  ): Promise<{ items: InboxItem[]; meta: CursorMeta }> {
    const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId), channel: 'IN_APP' };
    if (unreadOnly) filter.readAt = { $exists: false };
    if (cursor) {
      const c = decodeCursor(cursor);
      if (!c) throw new DomainError('VALIDATION_FAILED', 'Invalid cursor.');
      filter.$or = [{ createdAt: { $lt: c.createdAt } }, { createdAt: c.createdAt, _id: { $lt: c.id } }];
    }
    const docs = await this.notifications
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean<NotificationDoc[]>()
      .exec();
    const page = docs.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((d) => ({
        id: d._id.toHexString(),
        eventType: d.eventType,
        title: d.rendered?.title ?? '',
        body: d.rendered?.body ?? '',
        ...(d.rendered?.link ? { link: d.rendered.link } : {}),
        createdAt: d.createdAt.toISOString(),
        ...(d.readAt ? { readAt: d.readAt.toISOString() } : {}),
      })),
      meta: { nextCursor: docs.length > limit && last ? encodeCursor(last) : null },
    };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.notifications.countDocuments({
      userId: new Types.ObjectId(userId),
      channel: 'IN_APP',
      readAt: { $exists: false },
    });
  }

  async markRead(userId: string, id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Notification', id);
    const res = await this.notifications.updateOne(
      { _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId), channel: 'IN_APP' },
      [{ $set: { readAt: { $ifNull: ['$readAt', '$$NOW'] } } }],
    );
    if (res.matchedCount === 0) throw new NotFoundError('Notification', id);
  }

  async markAllRead(userId: string): Promise<number> {
    const res = await this.notifications.updateMany(
      { userId: new Types.ObjectId(userId), channel: 'IN_APP', readAt: { $exists: false } },
      { $set: { readAt: new Date() } },
    );
    return res.modifiedCount;
  }

  /* ------------------------------------------------------------------ preferences (FR-NTF-05) */

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const doc = await this.preferences
      .findOne({ userId: new Types.ObjectId(userId) })
      .lean<NotificationPreferenceDoc>()
      .exec();
    return doc
      ? { channels: { ...doc.channels }, mutedEventTypes: doc.mutedEventTypes }
      : structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);
  }

  async setPreferences(userId: string, prefs: NotificationPreferences): Promise<NotificationPreferences> {
    await this.preferences.updateOne(
      { userId: new Types.ObjectId(userId) },
      { $set: prefs },
      { upsert: true },
    );
    return this.getPreferences(userId);
  }
}
