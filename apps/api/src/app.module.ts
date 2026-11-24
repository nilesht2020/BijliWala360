import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { BackgroundModule, InlineBackgroundStarter } from './background.module';
import { AuthCoreModule } from './core/auth/auth-core.module';
import { CoreModule } from './core/core.module';
import { AllExceptionsFilter } from './core/http/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './core/http/response-envelope.interceptor';
import { ZodValidationPipe } from './core/http/zod';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { EnquiriesModule } from './modules/enquiries/enquiries.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { QuotationsModule } from './modules/quotations/quotations.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { PersonsModule } from './modules/persons/persons.module';
import { PlansModule } from './modules/plans/plans.module';
import { ProfessionalsModule } from './modules/professionals/professionals.module';
import { RegistrationsModule } from './modules/registrations/registrations.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PlatformModule } from './modules/platform/platform.module';
import { PermissionResolverService } from './modules/users/permission-resolver.service';
import { UsersModule } from './modules/users/users.module';

/**
 * HTTP application root. Business modules are added here one at a time (DEVELOPMENT_PLAN Phases 2-8).
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
    PlatformModule,
    CatalogModule,
    DocumentsModule,
    PlansModule,
    PersonsModule,
    ProfessionalsModule,
    VendorsModule,
    RegistrationsModule,
    CompaniesModule,
    EnquiriesModule,
    JobsModule,
    QuotationsModule,
    DashboardModule,
    BackgroundModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    InlineBackgroundStarter,
  ],
})
export class AppModule {}
