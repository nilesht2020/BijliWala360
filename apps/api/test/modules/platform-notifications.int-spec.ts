import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { WHATSAPP_PROVIDER, type ConsoleWhatsAppProvider } from '../../src/core/channels/channels';
import { BusinessConfigService } from '../../src/core/business-config/business-config.service';
import { DomainEventBus } from '../../src/core/outbox/event-bus';
import { OutboxRelay, type EventPublisher } from '../../src/core/outbox/outbox.relay';
import type { PublishedEvent } from '../../src/core/outbox/outbox.service';
import { OUTBOX_MODEL, type OutboxDoc } from '../../src/core/database/core.schemas';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import {
  NotificationsService,
  type DeliveryJob,
} from '../../src/modules/notifications/notifications.service';
import { PlatformModule } from '../../src/modules/platform/platform.module';
import { UsersModule } from '../../src/modules/users/users.module';
import { adminSignIn, seedAdmin, signUpViaOtp, smsOutbox } from '../setup/auth-helpers';
import { createTestApp, TEST_WEBHOOK_TOKEN, type TestApp } from '../setup/harness';

describe('Platform: audit logs, settings, notifications', () => {
  let t: TestApp;
  let superToken: string;
  let notifications: NotificationsService;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Runs the outbox relay with a publisher that dispatches straight into the event bus. */
  const pumpOutbox = async () => {
    const bus = t.app.get(DomainEventBus);
    const publisher: EventPublisher = { publish: (e: PublishedEvent) => bus.dispatch(e) };
    await new OutboxRelay(t.app.get<Model<OutboxDoc>>(getModelToken(OUTBOX_MODEL)), publisher).tick();
  };

  const deliverQueued = async () => {
    for (const job of t.queues.take('notifications')) await notifications.deliver(job.data as DeliveryJob);
  };

  beforeAll(async () => {
    t = await createTestApp({
      realAuth: true,
      imports: [UsersModule, AuthModule, NotificationsModule, PlatformModule],
    });
    notifications = t.app.get(NotificationsService);
    superToken = await adminSignIn(t, t.agent(), await seedAdmin(t, ['SUPER_ADMIN']));
    // Deterministic delivery regardless of the time of day the suite runs.
    await t.app
      .get(BusinessConfigService)
      .set('notification.quietHours', { enabled: false, startMin: 0, endMin: 0 }, { system: 'test' });
  });

  beforeEach(async () => {
    await t.redis.flushall();
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('audit logs API (FR-AUD-03)', () => {
    it('searches with filters and stable cursor pagination', async () => {
      for (let i = 0; i < 3; i += 1) await signUpViaOtp(t, t.agent());
      const page1 = await t
        .http()
        .get('/api/v1/admin/audit-logs?action=auth.signup&limit=2')
        .set(bearer(superToken))
        .expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.nextCursor).toEqual(expect.any(String));
      const page2 = await t
        .http()
        .get(`/api/v1/admin/audit-logs?action=auth.signup&limit=2&cursor=${page1.body.meta.nextCursor}`)
        .set(bearer(superToken))
        .expect(200);
      const ids = [...page1.body.data, ...page2.body.data].map((l: { id: string }) => l.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(page2.body.data.length).toBeGreaterThanOrEqual(1);

      const prefix = await t
        .http()
        .get('/api/v1/admin/audit-logs?action=auth.*&limit=100')
        .set(bearer(superToken))
        .expect(200);
      expect((prefix.body.data as Array<{ action: string }>).every((l) => l.action.startsWith('auth.'))).toBe(
        true,
      );
      await t.http().get('/api/v1/admin/audit-logs?cursor=garbage').set(bearer(superToken)).expect(400);
    });

    it('requires audit.read', async () => {
      const ops = await seedAdmin(t, ['SUPPORT_AGENT']);
      const token = await adminSignIn(t, t.agent(), ops);
      await t.http().get('/api/v1/admin/audit-logs').set(bearer(token)).expect(403);
    });
  });

  describe('settings API (FR-CFG-01)', () => {
    it('lists, validates, versions and audits configuration', async () => {
      const list = await t.http().get('/api/v1/admin/config').set(bearer(superToken)).expect(200);
      const entry = (list.body.data as Array<{ key: string; version: number; value: unknown }>).find(
        (e) => e.key === 'invitation.responseWindowHours',
      );
      expect(entry).toMatchObject({ value: 24, version: 0 });

      await t
        .http()
        .put('/api/v1/admin/config/invitation.responseWindowHours')
        .set(bearer(superToken))
        .send({ value: 1000 })
        .expect(400);
      await t
        .http()
        .put('/api/v1/admin/config/no.such.key')
        .set(bearer(superToken))
        .send({ value: 1 })
        .expect(404);
      const ok = await t
        .http()
        .put('/api/v1/admin/config/invitation.responseWindowHours')
        .set(bearer(superToken))
        .set('If-Match', '0')
        .send({ value: 48 })
        .expect(200);
      expect(ok.body.data).toMatchObject({ value: 48, version: 1, isDefault: false });
      await t
        .http()
        .put('/api/v1/admin/config/invitation.responseWindowHours')
        .set(bearer(superToken))
        .set('If-Match', '0')
        .send({ value: 12 })
        .expect(409);

      const ops = await seedAdmin(t, ['OPS_ADMIN']);
      const opsToken = await adminSignIn(t, t.agent(), ops);
      await t.http().get('/api/v1/admin/config').set(bearer(opsToken)).expect(403);
    });
  });

  describe('notifications (FR-NTF-01..06)', () => {
    it('delivers the welcome notification to the inbox and by SMS, exactly once', async () => {
      const user = await signUpViaOtp(t, t.agent(), { name: 'Meera' });
      await pumpOutbox();
      await pumpOutbox(); // redelivery is harmless
      const jobs = t.queues.jobs.filter(
        (j) => j.queue === 'notifications' && (j.data as DeliveryJob).userId === user.userId,
      );
      expect(jobs).toHaveLength(1);
      await deliverQueued();

      const welcome = smsOutbox(t.app).sent.filter(
        (m) => m.to === user.mobile && m.body.startsWith('Welcome'),
      );
      expect(welcome).toEqual([
        { to: user.mobile, body: 'Welcome to SkillConnect, Meera. Sign in to complete your profile.' },
      ]);

      const inbox = await t.http().get('/api/v1/notifications').set(bearer(user.accessToken)).expect(200);
      expect(inbox.body.data).toHaveLength(1);
      expect(inbox.body.data[0]).toMatchObject({
        eventType: 'account.created',
        title: 'Welcome to SkillConnect, Meera',
        link: '/provider',
      });

      const count = await t
        .http()
        .get('/api/v1/notifications/unread-count')
        .set(bearer(user.accessToken))
        .expect(200);
      expect(count.body.data.count).toBe(1);
      await t
        .http()
        .post(`/api/v1/notifications/${inbox.body.data[0].id}/read`)
        .set(bearer(user.accessToken))
        .expect(200);
      expect(
        (await t.http().get('/api/v1/notifications/unread-count').set(bearer(user.accessToken))).body.data
          .count,
      ).toBe(0);

      // Another user cannot touch this notification.
      const other = await signUpViaOtp(t, t.agent());
      await t
        .http()
        .post(`/api/v1/notifications/${inbox.body.data[0].id}/read`)
        .set(bearer(other.accessToken))
        .expect(404);
    });

    it('falls back to the next channel when one fails', async () => {
      const user = await signUpViaOtp(t, t.agent());
      await t
        .http()
        .post('/api/v1/admin/notification-templates')
        .set(bearer(superToken))
        .send({
          eventType: 'test.fallback',
          channel: 'WHATSAPP',
          audience: 'PROFESSIONAL',
          whatsapp: { templateName: 'fallback_v1', language: 'en', paramOrder: ['name'] },
        })
        .expect(201);
      await t
        .http()
        .post('/api/v1/admin/notification-templates')
        .set(bearer(superToken))
        .send({
          eventType: 'test.fallback',
          channel: 'SMS',
          audience: 'PROFESSIONAL',
          sms: { body: 'Fallback for {{name}}' },
        })
        .expect(201);

      const wa = t.app.get<ConsoleWhatsAppProvider>(WHATSAPP_PROVIDER);
      const spy = jest.spyOn(wa, 'send').mockRejectedValueOnce(new Error('WhatsApp API 503'));
      const outcome = await notifications.deliver({
        eventId: 'evt-fallback-1',
        userId: user.userId,
        eventType: 'test.fallback',
        priority: 'CRITICAL',
        data: { name: 'Ravi' },
        channels: ['WHATSAPP', 'SMS'],
      });
      expect(outcome.channel).toBe('SMS');
      expect(smsOutbox(t.app).sent.at(-1)).toEqual({ to: user.mobile, body: 'Fallback for Ravi' });
      const records = await t.connection
        .collection('notifications')
        .find({ eventId: 'evt-fallback-1' })
        .toArray();
      expect(Object.fromEntries(records.map((r) => [r.channel, r.status]))).toEqual({
        WHATSAPP: 'FAILED',
        SMS: 'SENT',
      });
      spy.mockRestore();

      // Re-running the same job (BullMQ retry) does not send again.
      const sentBefore = smsOutbox(t.app).sent.length;
      await notifications.deliver({
        eventId: 'evt-fallback-1',
        userId: user.userId,
        eventType: 'test.fallback',
        priority: 'CRITICAL',
        data: { name: 'Ravi' },
        channels: ['WHATSAPP', 'SMS'],
      });
      expect(smsOutbox(t.app).sent.length).toBe(sentBefore);
    });

    it('honours mutes for normal messages but never for critical ones, and throws when every channel fails', async () => {
      const user = await signUpViaOtp(t, t.agent());
      await t
        .http()
        .put('/api/v1/notifications/preferences')
        .set(bearer(user.accessToken))
        .send({ channels: { WHATSAPP: true, SMS: true, EMAIL: true }, mutedEventTypes: ['account.created'] })
        .expect(200);
      const normal = await notifications.deliver({
        eventId: 'evt-mute-1',
        userId: user.userId,
        eventType: 'account.created',
        priority: 'NORMAL',
        data: { name: 'x' },
        channels: ['SMS'],
      });
      expect(normal.channel).toBeNull();
      const critical = await notifications.deliver({
        eventId: 'evt-mute-2',
        userId: user.userId,
        eventType: 'account.created',
        priority: 'CRITICAL',
        data: { name: 'x' },
        channels: ['SMS'],
      });
      expect(critical.channel).toBe('SMS');

      const smsProvider = smsOutbox(t.app);
      const spy = jest.spyOn(smsProvider, 'send').mockRejectedValue(new Error('gateway down'));
      await expect(
        notifications.deliver({
          eventId: 'evt-fail-1',
          userId: user.userId,
          eventType: 'account.created',
          priority: 'CRITICAL',
          data: {},
          channels: ['SMS'],
        }),
      ).rejects.toThrow(/All channels failed/);
      spy.mockRestore();
    });

    it('defers normal messages during quiet hours', async () => {
      const cfg = t.app.get(BusinessConfigService);
      await cfg.set(
        'notification.quietHours',
        { enabled: true, startMin: 0, endMin: 1439 },
        { system: 'test' },
        1,
      );
      await signUpViaOtp(t, t.agent());
      await pumpOutbox();
      const job = t.queues.take('notifications').at(-1);
      expect(job?.opts.delay).toBeGreaterThan(0);
      await cfg.set(
        'notification.quietHours',
        { enabled: false, startMin: 0, endMin: 0 },
        { system: 'test' },
        2,
      );
    });

    it('manages templates with duplicate protection and preview', async () => {
      const list = await t
        .http()
        .get('/api/v1/admin/notification-templates')
        .set(bearer(superToken))
        .expect(200);
      const welcome = (
        list.body.data as Array<{
          id: string;
          eventType: string;
          channel: string;
          audience: string;
          variables: string[];
        }>
      ).find((x) => x.eventType === 'account.created' && x.channel === 'IN_APP' && x.audience === 'COMPANY');
      expect(welcome?.variables).toEqual(['name']);
      const preview = await t
        .http()
        .post(`/api/v1/admin/notification-templates/${welcome?.id}/preview`)
        .set(bearer(superToken))
        .send({ data: { name: 'Acme' } })
        .expect(200);
      expect(preview.body.data.title).toBe('Welcome to SkillConnect, Acme');

      const dup = await t
        .http()
        .post('/api/v1/admin/notification-templates')
        .set(bearer(superToken))
        .send({
          eventType: 'account.created',
          channel: 'IN_APP',
          audience: 'COMPANY',
          inApp: { title: 'x', body: 'y' },
        })
        .expect(409);
      expect(dup.body.error.code).toBe('TEMPLATE_DUPLICATE');
      await t
        .http()
        .post('/api/v1/admin/notification-templates')
        .set(bearer(superToken))
        .send({
          eventType: 'x.y',
          channel: 'EMAIL',
          audience: 'COMPANY',
          sms: { body: 'wrong channel content' },
        })
        .expect(400);
    });

    it('accepts delivery receipts only with the webhook token and never downgrades status', async () => {
      const user = await signUpViaOtp(t, t.agent());
      const outcome = await notifications.deliver({
        eventId: 'evt-receipt-1',
        userId: user.userId,
        eventType: 'account.created',
        priority: 'CRITICAL',
        data: { name: 'x' },
        channels: ['SMS'],
      });
      const id = outcome.channel ? outcome.providerMessageId : '';
      await t
        .http()
        .post('/api/v1/webhooks/notifications/msg91')
        .send({ providerMessageId: id, status: 'DELIVERED' })
        .expect(401);
      const ok = await t
        .http()
        .post('/api/v1/webhooks/notifications/msg91')
        .set('X-Webhook-Token', TEST_WEBHOOK_TOKEN)
        .send({ providerMessageId: id, status: 'DELIVERED' })
        .expect(200);
      expect(ok.body.data.updated).toBe(true);
      const again = await t
        .http()
        .post('/api/v1/webhooks/notifications/msg91')
        .set('X-Webhook-Token', TEST_WEBHOOK_TOKEN)
        .send({ providerMessageId: id, status: 'FAILED' })
        .expect(200);
      expect(again.body.data.updated).toBe(false);
    });

    it('marks everything read', async () => {
      const user = await signUpViaOtp(t, t.agent());
      await pumpOutbox();
      const res = await t
        .http()
        .post('/api/v1/notifications/read-all')
        .set(bearer(user.accessToken))
        .expect(200);
      expect(res.body.data.updated).toBe(1);
    });
  });
});
