import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { SanitizeMiddleware } from './http/sanitize';
import { AuditCoreModule } from './audit/audit.service';
import { BusinessConfigModule } from './business-config/business-config.service';
import { ChannelsModule } from './channels/channels';
import { AppConfigModule } from './config/app-config';
import { CryptoModule } from './crypto/field-crypto';
import { DatabaseModule } from './database/database.module';
import { FinanceModule } from './finance/webhooks';
import { HealthModule } from './health/health.controller';
import { LoggingModule } from './logging/logging.module';
import { OutboxModule } from './outbox/outbox.module';
import { QueueModule } from './queue/queue.registry';
import { RedisModule } from './redis/redis.module';
import { ScanningModule } from './scanning/clamav.client';
import { StorageModule } from './storage/storage.service';

/** All cross-cutting infrastructure (ARCHITECTURE §5). Imported once by AppModule and WorkerModule. */
@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    OutboxModule,
    AuditCoreModule,
    CryptoModule,
    BusinessConfigModule,
    StorageModule,
    ScanningModule,
    ChannelsModule,
    FinanceModule,
    HealthModule,
  ],
})
export class CoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SanitizeMiddleware).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
