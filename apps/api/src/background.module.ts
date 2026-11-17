import { Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { DomainEventBus } from './core/outbox/event-bus';
import { OutboxRelay } from './core/outbox/outbox.relay';
import type { PublishedEvent } from './core/outbox/outbox.service';
import { QUEUES, QueueRegistry } from './core/queue/queue.registry';
import { DocumentsModule, DocumentsService } from './modules/documents/documents.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { NotificationsService, type DeliveryJob } from './modules/notifications/notifications.service';
import { QuotationsModule, QuotationsService } from './modules/quotations/quotations.module';
import { RegistrationsModule } from './modules/registrations/registrations.module';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/**
 * Background processing: the outbox relay, domain-event dispatch (event consumers subscribe in
 * their modules' onModuleInit), notification delivery and scheduled jobs. Runs in the worker
 * process; in QUEUE_MODE=inline (development without Redis) the API process runs it instead.
 */
@Injectable()
export class BackgroundService {
  private readonly logger = new Logger('Background');
  private started = false;

  constructor(
    private readonly relay: OutboxRelay,
    private readonly bus: DomainEventBus,
    private readonly queues: QueueRegistry,
    private readonly notifications: NotificationsService,
    private readonly documents: DocumentsService,
    private readonly quotations: QuotationsService,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.queues.registerWorker<PublishedEvent>(QUEUES.DOMAIN_EVENTS, async (job) =>
      this.bus.dispatch(job.data),
    );
    this.queues.registerWorker<DeliveryJob>(QUEUES.NOTIFICATIONS, async (job) => {
      await this.notifications.deliver(job.data);
    });
    this.queues.registerWorker<object>(
      QUEUES.SCHEDULED,
      async (job) => {
        if (job.name === 'documents.expire') await this.documents.expireDue();
        if (job.name === 'quotations.expire') await this.quotations.expireDue();
      },
      1,
    );
    await this.queues.schedule(QUEUES.SCHEDULED, 'documents.expire', SIX_HOURS);
    await this.queues.schedule(QUEUES.SCHEDULED, 'quotations.expire', ONE_HOUR);
    this.relay.start();
    this.logger.log(`Background processing started (${this.queues.inline ? 'inline' : 'queue'} mode)`);
  }
}

/** Starts background processing inside the API process only when there is no Redis queue. */
@Injectable()
export class InlineBackgroundStarter implements OnApplicationBootstrap {
  constructor(
    private readonly background: BackgroundService,
    private readonly queues: QueueRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.queues.inline) await this.background.start();
  }
}

@Module({
  imports: [NotificationsModule, DocumentsModule, RegistrationsModule, QuotationsModule],
  providers: [BackgroundService],
  exports: [BackgroundService],
})
export class BackgroundModule {}
