import { Global, Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config';
import { PERMISSION_RESOLVER, type PermissionResolver } from './auth.types';
import { JwtAuthGuard, PermissionsGuard } from './guards';
import { RateLimitGuard } from './rate-limit';

/** Audience of access tokens. Short-lived step tokens (signup, MFA) use other audiences. */
export const ACCESS_TOKEN_AUDIENCE = 'access';

export interface AuthCoreOptions {
  /** The permission resolver implementation. */
  resolver: Type<PermissionResolver>;
  /** Modules that provide (and export) the resolver, e.g. UsersModule. */
  imports?: DynamicModule['imports'];
  /** true when `resolver` is provided by one of `imports`; false to instantiate it here. */
  resolverFromImports?: boolean;
}

/**
 * Global authentication/authorisation wiring. The Users module supplies the Redis-cached
 * permission resolver. Guard order: rate limit -> JWT -> permissions.
 * Access tokens carry `aud: "access"`; step tokens (signup/MFA) are signed for other audiences
 * and are therefore rejected by the JWT guard.
 */
@Global()
@Module({})
export class AuthCoreModule {
  static forRoot(options: AuthCoreOptions): DynamicModule {
    const resolverProvider: Provider = options.resolverFromImports
      ? { provide: PERMISSION_RESOLVER, useExisting: options.resolver }
      : { provide: PERMISSION_RESOLVER, useClass: options.resolver };
    return {
      module: AuthCoreModule,
      imports: [
        ...(options.imports ?? []),
        JwtModule.registerAsync({
          global: true,
          inject: [AppConfig],
          useFactory: (config: AppConfig) => ({
            secret: config.env.JWT_ACCESS_SECRET,
            signOptions: {
              expiresIn: config.env.JWT_ACCESS_TTL_SECONDS,
              issuer: config.env.JWT_ISSUER,
              audience: ACCESS_TOKEN_AUDIENCE,
              algorithm: 'HS256',
            },
            verifyOptions: {
              issuer: config.env.JWT_ISSUER,
              audience: ACCESS_TOKEN_AUDIENCE,
              algorithms: ['HS256'],
            },
          }),
        }),
      ],
      providers: [
        resolverProvider,
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
      exports: [PERMISSION_RESOLVER],
    };
  }
}
