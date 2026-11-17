import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { OUTBOX_MODEL, type OutboxDoc } from '../database/core.schemas';
import { QUEUES, QueueRegistry } from '../queue/queue.registry';
import type { PublishedEvent } from './outbox.service';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

export interface EventPublisher {
  publish(event: PublishedEvent): Promise<void>;
}

/** Publishes to BullMQ using eventId as jobId, so a re-publish after a crash is de-duplicated. */
@Injectable()
export class BullMqEventPublisher implements EventPublisher {
  constructor(private readonly queues: QueueRegistry) {}

  async publish(event: PublishedEvent): Promise<void> {
    await this.queues.add(QUEUES.DOMAIN_EVENTS, event.type, event, { jobId: event.eventId });
  }
}

export interface RelayOptions {
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
}

const DEFAULT_RELAY_OPTIONS: RelayOptions = { batchSize: 100, leaseMs: 30_000, maxAttempts: 20 };

/**
 * Polls `outbox_events` with a lease-claim so multiple worker replicas never publish the same
 * event concurrently. Delivery is at-least-once; consumers de-duplicate on eventId.
 */
@Injectable()
export class OutboxRelay implements OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectModel(OUTBOX_MODEL) private readonly outbox: Model<OutboxDoc>,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
  ) {}

  start(intervalMs = 1000, options: Partial<RelayOptions> = {}): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick(options)
        .catch((err: unknown) => this.logger.error({ err }, 'Outbox relay tick failed'))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
  }

  /** Processes up to `batchSize` events; returns how many were dispatched. */
  async tick(partial: Partial<RelayOptions> = {}): Promise<number> {
    const opts = { ...DEFAULT_RELAY_OPTIONS, ...partial };
    let dispatched = 0;
    for (let i = 0; i < opts.batchSize; i += 1) {
      const now = new Date();
      const claimed = await this.outbox
        .findOneAndUpdate(
          {
            status: 'PENDING',
            $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lt: now } }],
          },
          { $set: { leaseUntil: new Date(now.getTime() + opts.leaseMs) }, $inc: { attempts: 1 } },
          { sort: { createdAt: 1 }, new: true },
        )
        .lean()
        .exec();
      if (!claimed) break;

      const event: PublishedEvent = {
        eventId: claimed.eventId,
        type: claimed.type,
        aggregateType: claimed.aggregateType,
        aggregateId: claimed.aggregateId,
        payload: claimed.payload as Record<string, unknown>,
        occurredAt: (claimed as { createdAt?: Date }).createdAt?.toISOString() ?? now.toISOString(),
      };

      try {
        await this.publisher.publish(event);
        await this.outbox.updateOne(
          { _id: claimed._id },
          {
            $set: { status: 'DISPATCHED', dispatchedAt: new Date() },
            $unset: { leaseUntil: 1, lastError: 1 },
          },
        );
        dispatched += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failed = claimed.attempts >= opts.maxAttempts;
        await this.outbox.updateOne(
          { _id: claimed._id },
          {
            $set: { lastError: message, ...(failed ? { status: 'FAILED' } : {}) },
            $unset: { leaseUntil: 1 },
          },
        );
        this.logger.warn({ eventId: event.eventId, err: message }, 'Outbox publish failed');
        break; // back off until next tick
      }
    }
    return dispatched;
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
