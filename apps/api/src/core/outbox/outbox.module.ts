import { Global, Module } from '@nestjs/common';
import { DomainEventBus } from './event-bus';
import { BullMqEventPublisher, EVENT_PUBLISHER, OutboxRelay } from './outbox.relay';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  providers: [
    OutboxService,
    OutboxRelay,
    DomainEventBus,
    { provide: EVENT_PUBLISHER, useClass: BullMqEventPublisher },
  ],
  exports: [OutboxService, OutboxRelay, DomainEventBus, EVENT_PUBLISHER],
})
export class OutboxModule {}
