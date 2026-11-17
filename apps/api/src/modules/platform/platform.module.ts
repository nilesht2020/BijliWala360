import { Module } from '@nestjs/common';
import { AuditLogsController, SettingsController } from './platform.controllers';

/** Admin APIs over core platform services: audit log search and business configuration. */
@Module({ controllers: [AuditLogsController, SettingsController] })
export class PlatformModule {}
