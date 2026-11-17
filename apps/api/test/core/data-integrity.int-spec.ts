import { Module } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Schema, type Model } from 'mongoose';
import { AuditService } from '../../src/core/audit/audit.service';
import { BusinessConfigService } from '../../src/core/business-config/business-config.service';
import { AUDIT_MODEL, OUTBOX_MODEL, type OutboxDoc } from '../../src/core/database/core.schemas';
import { SequenceService } from '../../src/core/database/sequence.service';
import { TransactionRunner } from '../../src/core/database/transaction-runner';
import { DomainError } from '../../src/core/errors/domain-error';
import { DomainEventBus } from '../../src/core/outbox/event-bus';
import { OutboxRelay, type EventPublisher } from '../../src/core/outbox/outbox.relay';
import { OutboxService, type PublishedEvent } from '../../src/core/outbox/outbox.service';
import { createTestApp, type TestApp } from '../setup/harness';
import { PROBE_MODEL, ProbeController, probeSchema } from '../support/probe.controller';

/** A per-person lock document + slot inserts: the allocation concurrency pattern (ARCHITECTURE §6.3). */
const LOCK_MODEL = 'LockProbe';
const lockSchema = new Schema(
  { _id: String, version: { type: Number, default: 0 } },
  { collection: 'lock_probes' },
);
const SLOT_MODEL = 'SlotProbe';
const slotSchema = new Schema({ personId: String, slot: Number }, { collection: 'slot_probes' });

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PROBE_MODEL, schema: probeSchema },
      { name: LOCK_MODEL, schema: lockSchema },
      { name: SLOT_MODEL, schema: slotSchema },
    ]),
  ],
  exports: [MongooseModule],
})
class ProbeModelsModule {}

class RecordingPublisher implements EventPublisher {
  readonly published: PublishedEvent[] = [];
  failNext = false;

  async publish(event: PublishedEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('broker down');
    }
    this.published.push(event);
  }
}

describe('Data integrity core (transactions, outbox, sequences, config, events, audit)', () => {
  let t: TestApp;
  let txn: TransactionRunner;
  let outboxModel: Model<OutboxDoc>;

  beforeAll(async () => {
    t = await createTestApp({ imports: [ProbeModelsModule], controllers: [ProbeController] });
    txn = t.app.get(TransactionRunner);
    outboxModel = t.app.get(getModelToken(OUTBOX_MODEL));
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('TransactionRunner', () => {
    it('commits business data and outbox events atomically', async () => {
      await t.http().post('/api/v1/probe/txn/committed-1').expect(201);
      expect(await t.connection.collection('probes').countDocuments({ name: 'committed-1' })).toBe(1);
      expect(await outboxModel.countDocuments({ aggregateId: 'committed-1' })).toBe(1);
    });

    it('rolls back data and outbox events when the unit of work fails', async () => {
      await t.http().post('/api/v1/probe/txn/rolled-back-1?fail=1').expect(409);
      expect(await t.connection.collection('probes').countDocuments({ name: 'rolled-back-1' })).toBe(0);
      expect(await outboxModel.countDocuments({ aggregateId: 'rolled-back-1' })).toBe(0);
    });

    it('does not retry domain errors', async () => {
      let attempts = 0;
      await expect(
        txn.run(async () => {
          attempts += 1;
          throw new DomainError('STATE_CONFLICT', 'nope');
        }),
      ).rejects.toBeInstanceOf(DomainError);
      expect(attempts).toBe(1);
    });

    it('serialises concurrent writers on a shared lock document via WriteConflict retries', async () => {
      const locks = t.app.get<Model<{ _id: string; version: number }>>(getModelToken(LOCK_MODEL));
      const slots = t.app.get<Model<{ personId: string; slot: number }>>(getModelToken(SLOT_MODEL));
      await locks.create({ _id: 'person-1', version: 0 });

      // Each transaction books the next free slot for the same person: read-then-insert is only
      // safe because every writer first bumps the lock doc, forcing conflicting txns to retry.
      const book = () =>
        txn.run(
          async (session) => {
            await locks.updateOne({ _id: 'person-1' }, { $inc: { version: 1 } }, { session });
            const taken = await slots.countDocuments({ personId: 'person-1' }, { session });
            await slots.create([{ personId: 'person-1', slot: taken }], { session });
            return taken;
          },
          { maxRetries: 50 },
        );

      const results = await Promise.all(Array.from({ length: 10 }, book));
      expect([...results].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const stored = await slots.find({ personId: 'person-1' }).lean();
      expect(new Set(stored.map((s) => s.slot)).size).toBe(10);
      expect((await locks.findById('person-1').lean())?.version).toBe(10);
    });

    it('joins an existing transaction when a session is passed', async () => {
      const probes = t.app.get<Model<{ name: string }>>(getModelToken(PROBE_MODEL));
      await expect(
        txn.run(async (session) => {
          await probes.create([{ name: 'outer-1' }], { session });
          await txn.run(
            async (inner) => {
              expect(inner).toBe(session);
              await probes.create([{ name: 'inner-1' }], { session: inner });
            },
            { session },
          );
          throw new DomainError('STATE_CONFLICT', 'abort both');
        }),
      ).rejects.toBeInstanceOf(DomainError);
      expect(await probes.countDocuments({ name: { $in: ['outer-1', 'inner-1'] } })).toBe(0);
    });
  });

  describe('OutboxService', () => {
    it('refuses to write outside a transaction', async () => {
      const session = await t.connection.startSession();
      await expect(
        t.app
          .get(OutboxService)
          .add({ type: 'x.y', aggregateType: 'X', aggregateId: '1', payload: {} }, session),
      ).rejects.toThrow(/inside a transaction/);
      await session.endSession();
    });
  });

  describe('OutboxRelay', () => {
    const newRelay = (publisher: EventPublisher) => new OutboxRelay(outboxModel, publisher);

    beforeEach(async () => {
      await outboxModel.deleteMany({});
    });

    async function seedEvents(n: number): Promise<void> {
      await txn.run(async (session) => {
        await t.app.get(OutboxService).add(
          Array.from({ length: n }, (_, i) => ({
            type: 'probe.seeded',
            aggregateType: 'Probe',
            aggregateId: `seed-${i}`,
            payload: { i },
          })),
          session,
        );
      });
    }

    it('publishes pending events in order and marks them dispatched', async () => {
      await seedEvents(3);
      const publisher = new RecordingPublisher();
      expect(await newRelay(publisher).tick()).toBe(3);
      expect(publisher.published.map((e) => e.aggregateId)).toEqual(['seed-0', 'seed-1', 'seed-2']);
      expect(await outboxModel.countDocuments({ status: 'DISPATCHED' })).toBe(3);
      expect(await newRelay(publisher).tick()).toBe(0);
    });

    it('keeps events pending with the error after a publish failure, then succeeds on the next tick', async () => {
      await seedEvents(1);
      const publisher = new RecordingPublisher();
      publisher.failNext = true;
      expect(await newRelay(publisher).tick()).toBe(0);
      const failed = await outboxModel.findOne({}).lean();
      expect(failed).toMatchObject({ status: 'PENDING', lastError: 'broker down', attempts: 1 });
      expect(await newRelay(publisher).tick()).toBe(1);
    });

    it('never publishes the same event twice when relays run concurrently', async () => {
      await seedEvents(30);
      const publisher = new RecordingPublisher();
      await Promise.all([newRelay(publisher).tick(), newRelay(publisher).tick(), newRelay(publisher).tick()]);
      const ids = publisher.published.map((e) => e.eventId);
      expect(ids).toHaveLength(30);
      expect(new Set(ids).size).toBe(30);
    });
  });

  describe('DomainEventBus', () => {
    it('runs each consumer once per event id, even if the event is redelivered', async () => {
      const bus = t.app.get(DomainEventBus);
      const seen: string[] = [];
      bus.subscribe('probe.bus', 'consumer-a', async (e) => {
        seen.push(`a:${e.eventId}`);
      });
      bus.subscribe('probe.bus', 'consumer-b', async (e) => {
        seen.push(`b:${e.eventId}`);
      });
      const event: PublishedEvent = {
        eventId: 'evt-bus-1',
        type: 'probe.bus',
        aggregateType: 'Probe',
        aggregateId: '1',
        payload: {},
        occurredAt: new Date().toISOString(),
      };
      await bus.dispatch(event);
      await bus.dispatch(event);
      expect(seen).toEqual(['a:evt-bus-1', 'b:evt-bus-1']);
    });

    it('retries only the failed consumer on redelivery', async () => {
      const bus = t.app.get(DomainEventBus);
      let okRuns = 0;
      let flakyRuns = 0;
      bus.subscribe('probe.flaky', 'ok', async () => {
        okRuns += 1;
      });
      bus.subscribe('probe.flaky', 'flaky', async () => {
        flakyRuns += 1;
        if (flakyRuns === 1) throw new Error('transient');
      });
      const event: PublishedEvent = {
        eventId: 'evt-flaky-1',
        type: 'probe.flaky',
        aggregateType: 'Probe',
        aggregateId: '1',
        payload: {},
        occurredAt: new Date().toISOString(),
      };
      await expect(bus.dispatch(event)).rejects.toThrow(/flaky/);
      await bus.dispatch(event);
      expect({ okRuns, flakyRuns }).toEqual({ okRuns: 1, flakyRuns: 2 });
    });
  });

  describe('SequenceService', () => {
    it('hands out unique, contiguous numbers under concurrency', async () => {
      const seq = t.app.get(SequenceService);
      const values = await Promise.all(Array.from({ length: 50 }, () => seq.next('probe-seq')));
      expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    });

    it('does not consume a number when the surrounding transaction aborts (gap-free series)', async () => {
      const seq = t.app.get(SequenceService);
      expect(await seq.next('probe-gapfree')).toBe(1);
      await expect(
        txn.run(async (session) => {
          await seq.next('probe-gapfree', session);
          throw new DomainError('STATE_CONFLICT', 'abort');
        }),
      ).rejects.toBeInstanceOf(DomainError);
      expect(await seq.next('probe-gapfree')).toBe(2);
      expect(await seq.formatted('probe-fmt', 'JOB')).toBe('JOB-000001');
    });
  });

  describe('BusinessConfigService', () => {
    const actor = { userId: 'admin-1', userType: 'ADMIN' };

    it('returns the registry default when unset', async () => {
      const cfg = t.app.get(BusinessConfigService);
      expect(await cfg.get('invitation.responseWindowHours')).toBe(24);
    });

    it('validates, versions, audits and invalidates the cache on update', async () => {
      const cfg = t.app.get(BusinessConfigService);
      expect(await cfg.get('attendance.geofenceMeters')).toBe(200); // primes cache
      const v1 = await cfg.set('attendance.geofenceMeters', 350, actor, 0);
      expect(v1.version).toBe(1);
      expect(await cfg.get('attendance.geofenceMeters')).toBe(350);

      await cfg.set('attendance.geofenceMeters', 400, actor, 1);
      expect(await cfg.get('attendance.geofenceMeters')).toBe(400);

      const audits = await t.app
        .get<Model<{ action: string; entityId: string }>>(getModelToken(AUDIT_MODEL))
        .find({ action: 'config.update', entityId: 'attendance.geofenceMeters' })
        .lean();
      expect(audits).toHaveLength(2);
    });

    it('rejects invalid values, unknown keys and stale versions', async () => {
      const cfg = t.app.get(BusinessConfigService);
      await expect(cfg.set('attendance.geofenceMeters', 1, actor)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await expect(cfg.set('no.such.key', 1, actor)).rejects.toMatchObject({ code: 'CONFIG_KEY_UNKNOWN' });
      await cfg.set('otp.maxAttempts', 4, actor, 0);
      await expect(cfg.set('otp.maxAttempts', 3, actor, 0)).rejects.toMatchObject({
        code: 'VERSION_MISMATCH',
      });
    });

    it('lists every registry key with its effective value', async () => {
      const list = await t.app.get(BusinessConfigService).list();
      const geofence = list.find((e) => e.key === 'attendance.geofenceMeters');
      expect(geofence).toMatchObject({ value: 400, defaultValue: 200, isDefault: false });
      expect(list.find((e) => e.key === 'matching.weights')?.isDefault).toBe(true);
    });
  });

  describe('AuditService', () => {
    it('redacts secrets and sets retention only on non-financial entries', async () => {
      const audit = t.app.get(AuditService);
      await audit.record({
        actor: { userId: 'u1' },
        action: 'user.update',
        entityType: 'User',
        entityId: 'u1',
        after: { name: 'A', passwordHash: 'secret-hash' },
      });
      await audit.record({
        actor: { system: 'worker' },
        action: 'payment.succeeded',
        entityType: 'BusinessPayment',
        entityId: 'p1',
        isFinancial: true,
      });
      const model = t.app.get<Model<Record<string, unknown>>>(getModelToken(AUDIT_MODEL));
      const userEntry = await model.findOne({ entityId: 'u1' }).lean();
      const payEntry = await model.findOne({ entityId: 'p1' }).lean();
      expect((userEntry?.after as Record<string, unknown>).passwordHash).toBe('[REDACTED]');
      expect(userEntry?.expireAt).toBeInstanceOf(Date);
      expect(payEntry?.expireAt).toBeUndefined();
    });
  });
});
