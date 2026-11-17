import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersModule } from '../users/users.module';
import {
  NotificationsController,
  NotificationTemplatesController,
  NotificationWebhooksController,
} from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NOTIFICATION_SCHEMAS } from './schemas';
import { TemplatesService } from './templates.service';

/**
 * Notifications (SRS §8.1). Other modules call `NotificationsService.request(payload, session)`
 * inside their transaction; delivery happens in the worker process.
 */
@Module({
  imports: [MongooseModule.forFeature(NOTIFICATION_SCHEMAS), UsersModule],
  controllers: [NotificationsController, NotificationTemplatesController, NotificationWebhooksController],
  providers: [NotificationsService, TemplatesService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
