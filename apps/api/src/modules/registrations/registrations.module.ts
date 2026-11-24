import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Put,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MongooseModule } from '@nestjs/mongoose';
import {
  checklistSchema,
  checkoutVerifySchema,
  decisionReasonSchema,
  offlinePaymentSchema,
  offlineRefundCompleteSchema,
  paymentDecisionSchema,
  refundListQuerySchema,
  registrationListQuerySchema,
  registrationPaymentListQuerySchema,
  requestChangesSchema,
  selectPlanSchema,
  type OnlineOrderResponse,
  type ReadinessView,
  type RegistrationDetailView,
  type RegistrationPaymentView,
  type RegistrationRefundView,
  type RegistrationView,
} from '@bijliwala/contracts';
import type { AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, RequirePermissions } from '../../core/auth/decorators';
import { DomainError } from '../../core/errors/domain-error';
import { ReqContext } from '../../core/http/request-context';
import { PagedResult } from '../../core/http/response-envelope.interceptor';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';
import { Idempotent, IdempotencyInterceptor } from '../../core/idempotency/idempotency.interceptor';
import { DocumentsModule, DocumentsService } from '../documents/documents.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PersonsModule } from '../persons/persons.module';
import { PlansModule } from '../plans/plans.module';
import { ProfessionalsModule } from '../professionals/professionals.module';
import { UsersModule } from '../users/users.module';
import { VendorsModule } from '../vendors/vendors.module';
import { RegistrationPaymentsService } from './payments.service';
import { ProviderDirectory, RegistrationsService } from './registrations.service';
import { REGISTRATION_SCHEMAS } from './schemas';

class SelectPlanDto extends createZodDto(selectPlanSchema) {}
class CheckoutVerifyDto extends createZodDto(checkoutVerifySchema) {}
class OfflinePaymentDto extends createZodDto(offlinePaymentSchema) {}
class ChecklistDto extends createZodDto(checklistSchema) {}
class ReasonDto extends createZodDto(decisionReasonSchema) {}
class RequestChangesDto extends createZodDto(requestChangesSchema) {}
class PaymentDecisionDto extends createZodDto(paymentDecisionSchema) {}
class OfflineRefundDto extends createZodDto(offlineRefundCompleteSchema) {}
class RegistrationListDto extends createZodDto(registrationListQuerySchema) {}
class PaymentListDto extends createZodDto(registrationPaymentListQuerySchema) {}
class RefundListDto extends createZodDto(refundListQuerySchema) {}

/** Provider-facing registration endpoints (professionals and vendor admins). */
@ApiTags('Registration')
@ApiBearerAuth()
@Controller('registrations/me')
export class MyRegistrationController {
  constructor(
    private readonly registrations: RegistrationsService,
    private readonly payments: RegistrationPaymentsService,
  ) {}

  @Get()
  get(@CurrentUser() user: AuthUser): Promise<RegistrationView> {
    return this.registrations.getMine(user);
  }

  @Get('readiness')
  readiness(@CurrentUser() user: AuthUser): Promise<ReadinessView> {
    return this.registrations.myReadiness(user);
  }

  @Put('plan')
  @ApiZodBody(SelectPlanDto)
  plan(
    @Body() dto: SelectPlanDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationView> {
    return this.registrations.selectPlan(user, dto.planCode, ctx);
  }

  @Post('submit')
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @ReqContext() ctx: AuditContext): Promise<RegistrationView> {
    return this.registrations.submit(user, ctx);
  }

  @Get('payments')
  myPayments(@CurrentUser() user: AuthUser): Promise<RegistrationPaymentView[]> {
    return this.payments.myPayments(user);
  }

  @Post('payments/online')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  online(@CurrentUser() user: AuthUser): Promise<OnlineOrderResponse> {
    return this.payments.startOnline(user);
  }

  @Post('payments/:id/verify')
  @HttpCode(200)
  @ApiZodBody(CheckoutVerifyDto)
  verify(
    @Param('id') id: string,
    @Body() dto: CheckoutVerifyDto,
    @CurrentUser() user: AuthUser,
  ): Promise<RegistrationPaymentView> {
    return this.payments.verifyCheckout(user, id, dto);
  }

  @Post('payments/offline')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  @ApiZodBody(OfflinePaymentDto)
  offline(
    @Body() dto: OfflinePaymentDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationPaymentView> {
    return this.payments.recordOffline(user, dto, ctx);
  }
}

/** Verification queue, fee administration and refunds. */
@ApiTags('Registration (admin)')
@ApiBearerAuth()
@Controller('admin')
export class AdminRegistrationsController {
  constructor(
    private readonly registrations: RegistrationsService,
    private readonly payments: RegistrationPaymentsService,
    private readonly providers: ProviderDirectory,
    private readonly documents: DocumentsService,
  ) {}

  @Get('registrations')
  @RequirePermissions('registration.verify')
  @ApiZodQuery(RegistrationListDto)
  async list(@Query() q: RegistrationListDto): Promise<PagedResult<RegistrationView>> {
    const { items, meta } = await this.registrations.list(q);
    return new PagedResult(items, meta);
  }

  @Get('registrations/:id')
  @RequirePermissions('registration.verify')
  async detail(@Param('id') id: string): Promise<RegistrationDetailView> {
    const reg = await this.registrations.getById(id);
    const provider = await this.providers.byId(reg.providerType, reg.providerId);
    const [registration, providerView, documents, required, money] = await Promise.all([
      this.registrations.view(reg),
      this.providers.view(provider),
      this.documents.listForOwner(reg.providerType, reg.providerId.toHexString(), true),
      this.registrations.requiredDocTypesFor(reg),
      this.payments.forRegistration(reg._id),
    ]);
    return { registration, provider: providerView, documents, requiredDocTypeCodes: required, ...money };
  }

  @Put('registrations/:id/checklist')
  @RequirePermissions('registration.verify')
  @ApiZodBody(ChecklistDto)
  checklist(
    @Param('id') id: string,
    @Body() dto: ChecklistDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationView> {
    return this.registrations.saveChecklist(id, dto, user, ctx);
  }

  @Post('registrations/:id/approve')
  @HttpCode(200)
  @RequirePermissions('registration.verify')
  approve(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationView> {
    return this.registrations.approve(id, user, ctx);
  }

  @Post('registrations/:id/reject')
  @HttpCode(200)
  @RequirePermissions('registration.verify')
  @ApiZodBody(ReasonDto)
  reject(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationView> {
    return this.registrations.reject(id, dto.reason, user, ctx);
  }

  @Post('registrations/:id/request-changes')
  @HttpCode(200)
  @RequirePermissions('registration.verify')
  @ApiZodBody(RequestChangesDto)
  requestChanges(
    @Param('id') id: string,
    @Body() dto: RequestChangesDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationView> {
    return this.registrations.requestChanges(id, dto.comment, dto.items, user, ctx);
  }

  @Post('registrations/:id/waive')
  @HttpCode(200)
  @RequirePermissions('registration.waive')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  @ApiZodBody(ReasonDto)
  waive(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationView> {
    return this.payments.waive(id, dto.reason, user, ctx);
  }

  @Get('registration-payments')
  @RequirePermissions('payment.read')
  @ApiZodQuery(PaymentListDto)
  async payments_(@Query() q: PaymentListDto): Promise<PagedResult<RegistrationPaymentView>> {
    const { items, meta } = await this.payments.list(q);
    return new PagedResult(items, meta);
  }

  @Post('registration-payments/:id/verify')
  @HttpCode(200)
  @RequirePermissions('payment.verify')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  verifyPayment(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationPaymentView> {
    return this.payments.verifyOffline(id, user, ctx);
  }

  @Post('registration-payments/:id/reject')
  @HttpCode(200)
  @RequirePermissions('payment.verify')
  @ApiZodBody(PaymentDecisionDto)
  rejectPayment(
    @Param('id') id: string,
    @Body() dto: PaymentDecisionDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationPaymentView> {
    return this.payments.rejectOffline(id, dto.reason, user, ctx);
  }

  @Get('registration-refunds')
  @RequirePermissions('payment.read')
  @ApiZodQuery(RefundListDto)
  async refunds(@Query() q: RefundListDto): Promise<PagedResult<RegistrationRefundView>> {
    const { items, meta } = await this.payments.listRefunds(q);
    return new PagedResult(items, meta);
  }

  @Post('registration-refunds/:id/approve')
  @HttpCode(200)
  @RequirePermissions('refund.approve')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  approveRefund(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationRefundView> {
    return this.payments.approveRefund(id, user, ctx);
  }

  @Post('registration-refunds/:id/reject')
  @HttpCode(200)
  @RequirePermissions('refund.approve')
  @ApiZodBody(PaymentDecisionDto)
  rejectRefund(
    @Param('id') id: string,
    @Body() dto: PaymentDecisionDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationRefundView> {
    return this.payments.rejectRefund(id, dto.reason, user, ctx);
  }

  @Post('registration-refunds/:id/offline-complete')
  @HttpCode(200)
  @RequirePermissions('payment.verify')
  @ApiZodBody(OfflineRefundDto)
  completeRefund(
    @Param('id') id: string,
    @Body() dto: OfflineRefundDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationRefundView> {
    if (!dto.reference) throw new DomainError('VALIDATION_FAILED', 'Enter the transfer reference.');
    return this.payments.completeOfflineRefund(id, dto.reference, user, ctx);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature(REGISTRATION_SCHEMAS),
    UsersModule,
    PlansModule,
    PersonsModule,
    DocumentsModule,
    ProfessionalsModule,
    VendorsModule,
    NotificationsModule,
  ],
  controllers: [MyRegistrationController, AdminRegistrationsController],
  providers: [ProviderDirectory, RegistrationsService, RegistrationPaymentsService],
  exports: [RegistrationsService, RegistrationPaymentsService],
})
export class RegistrationsModule {}
