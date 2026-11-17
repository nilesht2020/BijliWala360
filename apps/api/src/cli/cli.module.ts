import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../core/auth/auth-core.module';
import { CoreModule } from '../core/core.module';
import { AuthModule } from '../modules/auth/auth.module';
import { CatalogModule } from '../modules/catalog/catalog.module';
import { DocumentsModule } from '../modules/documents/documents.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { PersonsModule } from '../modules/persons/persons.module';
import { PlansModule } from '../modules/plans/plans.module';
import { ProfessionalsModule } from '../modules/professionals/professionals.module';
import { RegistrationsModule } from '../modules/registrations/registrations.module';
import { PermissionResolverService } from '../modules/users/permission-resolver.service';
import { UsersModule } from '../modules/users/users.module';
import { VendorsModule } from '../modules/vendors/vendors.module';

/**
 * Root module for command-line tasks: every model and service, but no HTTP server and no
 * background processing (so a CLI run never consumes jobs or keeps timers alive).
 */
@Module({
  imports: [
    CoreModule,
    AuthCoreModule.forRoot({
      imports: [UsersModule],
      resolver: PermissionResolverService,
      resolverFromImports: true,
    }),
    UsersModule,
    AuthModule,
    NotificationsModule,
    CatalogModule,
    DocumentsModule,
    PlansModule,
    PersonsModule,
    ProfessionalsModule,
    VendorsModule,
    RegistrationsModule,
  ],
})
export class CliModule {}
