import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PermissionResolverService } from './permission-resolver.service';
import { RolesService } from './roles.service';
import { USER_SCHEMAS } from './schemas';
import { UserAdminService } from './user-admin.service';
import { AdminRolesController, AdminUsersController, MeController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Users & RBAC (SRS §3.2). Public API for other modules: UsersService (identity),
 * RolesService (grant/revoke in scope), PermissionResolverService (used by the global JWT guard).
 */
@Module({
  imports: [MongooseModule.forFeature(USER_SCHEMAS)],
  controllers: [AdminUsersController, AdminRolesController, MeController],
  providers: [UsersService, RolesService, UserAdminService, PermissionResolverService],
  exports: [UsersService, RolesService, PermissionResolverService],
})
export class UsersModule {}
