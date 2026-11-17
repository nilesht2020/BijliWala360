import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import { OUTBOX_MODEL, type OutboxDoc } from '../database/core.schemas';

export interface DomainEvent<P extends object = Record<string, unknown>> {
  /** `<aggregate>.<pastTenseVerb>` e.g. `allocation.approved`. */
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: P;
}

export interface PublishedEvent<P extends object = Record<string, unknown>> extends DomainEvent<P> {
  eventId: string;
  occurredAt: string;
}

/**
 * Transactional outbox writer (ARCHITECTURE §6.6). Events are inserted in the caller's
 * transaction, so they exist if and only if the business change committed. The OutboxRelay
 * (worker process) publishes them to BullMQ afterwards.
 */
@Injectable()
export class OutboxService {
  constructor(@InjectModel(OUTBOX_MODEL) private readonly outbox: Model<OutboxDoc>) {}

  async add(events: DomainEvent | DomainEvent[], session: ClientSession): Promise<string[]> {
    const list = Array.isArray(events) ? events : [events];
    if (list.length === 0) return [];
    if (!session.inTransaction()) {
      throw new Error('OutboxService.add must be called inside a transaction');
    }
    const docs = list.map((e) => ({
      eventId: randomUUID(),
      type: e.type,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      payload: e.payload,
      status: 'PENDING' as const,
      attempts: 0,
    }));
    await this.outbox.insertMany(docs, { session, ordered: true });
    return docs.map((d) => d.eventId);
  }
}
