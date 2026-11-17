import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createAdminUserSchema,
  createRoleSchema,
  grantRoleSchema,
  statusChangeSchema,
  updateMeSchema,
  updateRoleSchema,
  updateUserSchema,
  userListQuerySchema,
  type RoleAssignmentView,
  type RoleView,
  type UserDetailView,
  type UserView,
} from '@skillconnect/contracts';
import { actorFromUser, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, RequirePermissions } from '../../core/auth/decorators';
import { parseIfMatch } from '../../core/http/if-match';
import { ReqContext } from '../../core/http/request-context';
import { PagedResult } from '../../core/http/response-envelope.interceptor';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';
import { RolesService, toAssignmentView, toRoleView } from './roles.service';
import { UserAdminService } from './user-admin.service';
import { toUserView, UsersService } from './users.service';

class UserListQueryDto extends createZodDto(userListQuerySchema) {}
class CreateAdminUserDto extends createZodDto(createAdminUserSchema) {}
class UpdateUserDto extends createZodDto(updateUserSchema) {}
class StatusChangeDto extends createZodDto(statusChangeSchema) {}
class GrantRoleDto extends createZodDto(grantRoleSchema) {}
class CreateRoleDto extends createZodDto(createRoleSchema) {}
class UpdateRoleDto extends createZodDto(updateRoleSchema) {}
class UpdateMeDto extends createZodDto(updateMeSchema) {}

@ApiTags('Users (admin)')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly admin: UserAdminService,
    private readonly users: UsersService,
    private readonly roles: RolesService,
  ) {}

  @Get()
  @RequirePermissions('user.read')
  @ApiZodQuery(UserListQueryDto)
  async list(@Query() query: UserListQueryDto): Promise<PagedResult<UserView>> {
    const { items, meta } = await this.admin.list(query);
    return new PagedResult(items, meta);
  }

  @Post()
  @RequirePermissions('user.manage')
  @ApiZodBody(CreateAdminUserDto)
  create(
    @Body() dto: CreateAdminUserDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<UserDetailView> {
    return this.admin.createAdmin(dto, actorFromUser(user), ctx);
  }

  @Get(':id')
  @RequirePermissions('user.read')
  detail(@Param('id') id: string): Promise<UserDetailView> {
    return this.admin.detail(id);
  }

  @Patch(':id')
  @RequirePermissions('user.manage')
  @ApiZodBody(UpdateUserDto)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<UserDetailView> {
    await this.users.update(id, dto, actorFromUser(user), ctx);
    return this.admin.detail(id);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermissions('user.manage')
  @ApiZodBody(StatusChangeDto)
  suspend(
    @Param('id') id: string,
    @Body() dto: StatusChangeDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ) {
    return this.admin.setStatus(id, 'SUSPENDED', dto.reason, actorFromUser(user), ctx);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions('user.manage')
  @ApiZodBody(StatusChangeDto)
  reactivate(
    @Param('id') id: string,
    @Body() dto: StatusChangeDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ) {
    return this.admin.setStatus(id, 'ACTIVE', dto.reason, actorFromUser(user), ctx);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermissions('user.manage')
  @ApiZodBody(StatusChangeDto)
  deactivate(
    @Param('id') id: string,
    @Body() dto: StatusChangeDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ) {
    return this.admin.setStatus(id, 'DEACTIVATED', dto.reason, actorFromUser(user), ctx);
  }

  @Post(':id/mfa/reset')
  @HttpCode(200)
  @RequirePermissions('user.manage')
  async resetMfa(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<UserDetailView> {
    await this.users.resetMfa(id, actorFromUser(user), ctx);
    return this.admin.detail(id);
  }

  @Post(':id/role-assignments')
  @RequirePermissions('role.manage')
  @ApiZodBody(GrantRoleDto)
  async grant(
    @Param('id') id: string,
    @Body() dto: GrantRoleDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RoleAssignmentView> {
    return toAssignmentView(await this.roles.grant(id, dto, actorFromUser(user), ctx));
  }

  @Delete(':id/role-assignments/:assignmentId')
  @RequirePermissions('role.manage')
  async revoke(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<{ revoked: true }> {
    await this.roles.revoke(id, assignmentId, actorFromUser(user), ctx);
    return { revoked: true };
  }
}

@ApiTags('Roles (admin)')
@ApiBearerAuth()
@Controller('admin/roles')
@RequirePermissions('role.manage')
export class AdminRolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list(): Promise<RoleView[]> {
    return this.roles.list();
  }

  @Post()
  @ApiZodBody(CreateRoleDto)
  create(
    @Body() dto: CreateRoleDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RoleView> {
    return this.roles.create(dto, actorFromUser(user), ctx);
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<RoleView> {
    return toRoleView(await this.roles.getById(id));
  }

  @Patch(':id')
  @ApiZodBody(UpdateRoleDto)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RoleView> {
    return this.roles.update(id, dto, parseIfMatch(ifMatch), actorFromUser(user), ctx);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<{ deleted: true }> {
    await this.roles.remove(id, actorFromUser(user), ctx);
    return { deleted: true };
  }
}

@ApiTags('Account')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Patch()
  @ApiZodBody(UpdateMeDto)
  async update(
    @Body() dto: UpdateMeDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<UserView> {
    return toUserView(await this.users.update(user.id, dto, actorFromUser(user), ctx), user.roleCodes);
  }
}
