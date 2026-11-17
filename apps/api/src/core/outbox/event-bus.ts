import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { PROCESSED_EVENT_MODEL } from '../database/core.schemas';
import type { PublishedEvent } from './outbox.service';

export type EventHandler = (event: PublishedEvent) => Promise<void>;

interface Registration {
  consumer: string;
  handler: EventHandler;
}

/**
 * Worker-side dispatcher for domain events. Each consumer is idempotent by (consumer, eventId):
 * a successful run is recorded in `processed_events` and later duplicates are skipped.
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);
  private readonly handlers = new Map<string, Registration[]>();

  constructor(
    @InjectModel(PROCESSED_EVENT_MODEL)
    private readonly processed: Model<{ consumer: string; eventId: string }>,
  ) {}

  subscribe(eventType: string, consumer: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    if (list.some((r) => r.consumer === consumer)) {
      throw new Error(`Consumer ${consumer} is already subscribed to ${eventType}`);
    }
    list.push({ consumer, handler });
    this.handlers.set(eventType, list);
  }

  /** Runs all consumers for the event; throws if any consumer failed so the job is retried. */
  async dispatch(event: PublishedEvent): Promise<void> {
    const regs = this.handlers.get(event.type) ?? [];
    const failures: string[] = [];
    for (const reg of regs) {
      const already = await this.processed.exists({ consumer: reg.consumer, eventId: event.eventId });
      if (already) continue;
      try {
        await reg.handler(event);
        await this.processed.updateOne(
          { consumer: reg.consumer, eventId: event.eventId },
          { $setOnInsert: { processedAt: new Date() } },
          { upsert: true },
        );
      } catch (err) {
        this.logger.error({ err, consumer: reg.consumer, eventId: event.eventId }, 'Event consumer failed');
        failures.push(reg.consumer);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Consumers failed for ${event.type}: ${failures.join(', ')}`);
    }
  }
}
