import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  inboxQuerySchema,
  notificationPreferencesSchema,
  notificationTemplateSchema,
  templatePreviewSchema,
  type InboxItem,
  type NotificationPreferences,
  type NotificationTemplateView,
} from '@bijliwala/contracts';
import { actorFromUser, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, Public, RequirePermissions } from '../../core/auth/decorators';
import { AppConfig } from '../../core/config/app-config';
import { DomainError } from '../../core/errors/domain-error';
import { parseIfMatch } from '../../core/http/if-match';
import { ReqContext } from '../../core/http/request-context';
import { PagedResult } from '../../core/http/response-envelope.interceptor';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';
import { NotificationsService } from './notifications.service';
import { toTemplateView, TemplatesService, type RenderedMessage } from './templates.service';

class InboxQueryDto extends createZodDto(inboxQuerySchema) {}
class PreferencesDto extends createZodDto(notificationPreferencesSchema) {}
class TemplateDto extends createZodDto(notificationTemplateSchema) {}
class PreviewDto extends createZodDto(templatePreviewSchema) {}
class DeliveryStatusDto extends createZodDto(
  z
    .object({
      providerMessageId: z.string().min(1).max(200),
      status: z.enum(['DELIVERED', 'READ', 'FAILED']),
      error: z.string().max(500).optional(),
    })
    .strict(),
) {}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiZodQuery(InboxQueryDto)
  async inbox(@Query() q: InboxQueryDto, @CurrentUser() user: AuthUser): Promise<PagedResult<InboxItem>> {
    const { items, meta } = await this.notifications.inbox(user.id, q.cursor, q.limit, q.unread === 'true');
    return new PagedResult(items, meta);
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthUser): Promise<{ count: number }> {
    return { count: await this.notifications.unreadCount(user.id) };
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll(@CurrentUser() user: AuthUser): Promise<{ updated: number }> {
    return { updated: await this.notifications.markAllRead(user.id) };
  }

  @Post(':id/read')
  @HttpCode(200)
  async read(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<{ read: true }> {
    await this.notifications.markRead(user.id, id);
    return { read: true };
  }

  @Get('preferences')
  preferences(@CurrentUser() user: AuthUser): Promise<NotificationPreferences> {
    return this.notifications.getPreferences(user.id);
  }

  @Put('preferences')
  @ApiZodBody(PreferencesDto)
  setPreferences(
    @Body() dto: PreferencesDto,
    @CurrentUser() user: AuthUser,
  ): Promise<NotificationPreferences> {
    return this.notifications.setPreferences(user.id, dto);
  }
}

@ApiTags('Notification templates (admin)')
@ApiBearerAuth()
@Controller('admin/notification-templates')
@RequirePermissions('template.manage')
export class NotificationTemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(): Promise<NotificationTemplateView[]> {
    return this.templates.list();
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<NotificationTemplateView> {
    return toTemplateView(await this.templates.get(id));
  }

  @Post()
  @ApiZodBody(TemplateDto)
  create(
    @Body() dto: TemplateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<NotificationTemplateView> {
    return this.templates.create(dto, actorFromUser(user), ctx);
  }

  @Patch(':id')
  @ApiZodBody(TemplateDto)
  update(
    @Param('id') id: string,
    @Body() dto: TemplateDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<NotificationTemplateView> {
    return this.templates.update(id, dto, parseIfMatch(ifMatch), actorFromUser(user), ctx);
  }

  @Post(':id/preview')
  @HttpCode(200)
  @ApiZodBody(PreviewDto)
  preview(@Param('id') id: string, @Body() dto: PreviewDto): Promise<RenderedMessage> {
    return this.templates.preview(id, dto.data);
  }
}

/** Delivery receipts from SMS/WhatsApp providers, authenticated with a shared token. */
@Controller('webhooks/notifications')
export class NotificationWebhooksController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async status(
    @Param('provider') _provider: string,
    @Headers('x-webhook-token') token: string | undefined,
    @Body() dto: DeliveryStatusDto,
  ): Promise<{ updated: boolean }> {
    const expected = this.config.env.NOTIFICATION_WEBHOOK_TOKEN;
    const ok =
      !!expected &&
      !!token &&
      token.length === expected.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!ok) throw new DomainError('WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook token.');
    return { updated: await this.notifications.markDelivery(dto.providerMessageId, dto.status, dto.error) };
  }
}
