import { Body, Controller, Get, Headers, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  auditQuerySchema,
  isBusinessConfigKey,
  updateConfigSchema,
  type AuditLogView,
  type ConfigEntryView,
} from '@bijliwala/contracts';
import { actorFromUser, AuditService, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, RequirePermissions } from '../../core/auth/decorators';
import {
  BusinessConfigService,
  type BusinessConfigEntryView,
} from '../../core/business-config/business-config.service';
import { DomainError } from '../../core/errors/domain-error';
import { parseIfMatch } from '../../core/http/if-match';
import { ReqContext } from '../../core/http/request-context';
import { PagedResult } from '../../core/http/response-envelope.interceptor';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';

class AuditQueryDto extends createZodDto(auditQuerySchema) {}
class UpdateConfigDto extends createZodDto(updateConfigSchema) {}

function toView(e: BusinessConfigEntryView): ConfigEntryView {
  return { ...e, ...(e.updatedAt ? { updatedAt: e.updatedAt.toISOString() } : {}) } as ConfigEntryView;
}

/** Audit log explorer API (FR-AUD-03). Read-only by design (FR-AUD-02). */
@ApiTags('Audit logs (admin)')
@ApiBearerAuth()
@Controller('admin/audit-logs')
export class AuditLogsController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  @ApiZodQuery(AuditQueryDto)
  async search(@Query() q: AuditQueryDto): Promise<PagedResult<AuditLogView>> {
    const { items, meta } = await this.audit.search(q);
    return new PagedResult(items, meta);
  }
}

/** Business configuration API (FR-CFG-01): typed, validated, versioned (If-Match) and audited. */
@ApiTags('Settings (admin)')
@ApiBearerAuth()
@Controller('admin/config')
export class SettingsController {
  constructor(private readonly config: BusinessConfigService) {}

  @Get()
  @RequirePermissions('config.read')
  async list(): Promise<ConfigEntryView[]> {
    return (await this.config.list()).map(toView);
  }

  @Get(':key')
  @RequirePermissions('config.read')
  async get(@Param('key') key: string): Promise<ConfigEntryView> {
    if (!isBusinessConfigKey(key))
      throw new DomainError('CONFIG_KEY_UNKNOWN', `Unknown configuration key ${key}.`);
    const entry = (await this.config.list()).find((e) => e.key === key);
    return toView(entry as BusinessConfigEntryView);
  }

  @Put(':key')
  @RequirePermissions('config.manage')
  @ApiZodBody(UpdateConfigDto)
  async set(
    @Param('key') key: string,
    @Body() dto: UpdateConfigDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqContext() _ctx: AuditContext,
  ): Promise<ConfigEntryView> {
    return toView(await this.config.set(key, dto.value, actorFromUser(user), parseIfMatch(ifMatch)));
  }
}
