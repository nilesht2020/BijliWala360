import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { JobsOptions } from 'bullmq';
import RedisMock from 'ioredis-mock';
import type { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Permission, ScopeType, UserType } from '@skillconnect/contracts';
import { configureApp } from '../../src/bootstrap';
import { AuthCoreModule } from '../../src/core/auth/auth-core.module';
import type { PermissionResolver, ResolvedAccess, RoleScope } from '../../src/core/auth/auth.types';
import { CoreModule } from '../../src/core/core.module';
import { AllExceptionsFilter } from '../../src/core/http/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from '../../src/core/http/response-envelope.interceptor';
import { ZodValidationPipe } from '../../src/core/http/zod';
import { QueueRegistry, type QueueName } from '../../src/core/queue/queue.registry';
import { REDIS } from '../../src/core/redis/redis.module';
import { PermissionResolverService } from '../../src/modules/users/permission-resolver.service';
import { UsersModule } from '../../src/modules/users/users.module';

let dbCounter = 0;

export const TEST_WEBHOOK_TOKEN = 'test-webhook-token-0123456789';

/** Sets the minimum environment the app needs; each test file gets its own database. */
export function setTestEnv(dbName: string): void {
  const base = process.env.TEST_MONGO_URI;
  if (!base) throw new Error('TEST_MONGO_URI not set; is the integration globalSetup configured?');
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    MONGO_URI: url.toString(),
    REDIS_URL: 'redis://localhost:6399',
    JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0123',
    FIELD_ENCRYPTION_KEYS: `1:${randomBytes(32).toString('base64')}`,
    HASH_PEPPER: 'test-pepper-test-pepper-test-pepper-0123',
    SWAGGER_ENABLED: 'false',
    WEB_BASE_URL: 'http://web.test',
    NOTIFICATION_WEBHOOK_TOKEN: TEST_WEBHOOK_TOKEN,
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: join(tmpdir(), 'skillconnect-test-storage', dbName),
    SCANNER: 'none',
    QUEUE_MODE: 'queue',
  });
}

/** In-memory resolver: tests register principals and their permissions/scopes. */
export class FakePermissionResolver implements PermissionResolver {
  static readonly principals = new Map<string, ResolvedAccess>();

  async resolve(userId: string): Promise<ResolvedAccess | null> {
    return FakePermissionResolver.principals.get(userId) ?? null;
  }
}

export interface RecordedJob {
  queue: QueueName;
  name: string;
  data: unknown;
  opts: JobsOptions;
}

/** Replaces BullMQ in tests (no Redis): records jobs, de-duplicating by jobId like BullMQ does. */
export class RecordingQueues {
  readonly jobs: RecordedJob[] = [];
  readonly inline = false;

  async schedule(): Promise<void> {
    /* scheduled jobs are invoked explicitly in tests */
  }

  async add<T extends object>(
    queue: QueueName,
    name: string,
    data: T,
    opts: JobsOptions = {},
  ): Promise<void> {
    if (opts.jobId && this.jobs.some((j) => j.queue === queue && j.opts.jobId === opts.jobId)) return;
    this.jobs.push({ queue, name, data, opts });
  }

  registerWorker(): void {
    /* workers are driven explicitly in tests */
  }

  take(queue: QueueName): RecordedJob[] {
    const taken = this.jobs.filter((j) => j.queue === queue);
    for (const j of taken) this.jobs.splice(this.jobs.indexOf(j), 1);
    return taken;
  }

  async onApplicationShutdown(): Promise<void> {
    /* nothing to close */
  }
}

export interface PrincipalSpec {
  id?: string;
  userType?: UserType;
  permissions?: Permission[];
  roleCodes?: string[];
  scopes?: RoleScope[];
}

export interface TestApp {
  app: NestExpressApplication;
  http: () => ReturnType<typeof request>;
  /** A cookie-preserving client (refresh-token cookie flows). */
  agent: () => ReturnType<typeof request.agent>;
  connection: Connection;
  redis: InstanceType<typeof RedisMock>;
  queues: RecordingQueues;
  /** Registers a principal (fake resolver only) and returns a signed bearer token for it. */
  tokenFor: (spec?: PrincipalSpec) => Promise<string>;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  dbName?: string;
  imports?: Array<Type<unknown> | DynamicModule>;
  controllers?: Array<Type<unknown>>;
  providers?: Provider[];
  /** Use the real Users-module permission resolver instead of the in-memory fake. */
  realAuth?: boolean;
}

/**
 * Boots the real HTTP pipeline (CoreModule + global guards/pipes/filters/interceptors +
 * configureApp) against an in-memory replica set, a mocked Redis and a recording queue.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  dbCounter += 1;
  setTestEnv(options.dbName ?? `it_${process.pid}_${Date.now()}_${dbCounter}`);

  const authCore = options.realAuth
    ? AuthCoreModule.forRoot({
        imports: [UsersModule],
        resolver: PermissionResolverService,
        resolverFromImports: true,
      })
    : AuthCoreModule.forRoot({ resolver: FakePermissionResolver });

  @Module({
    imports: [CoreModule, authCore, ...(options.imports ?? [])],
    controllers: options.controllers ?? [],
    providers: [
      { provide: APP_PIPE, useClass: ZodValidationPipe },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
      ...(options.providers ?? []),
    ],
  })
  class TestRootModule {}

  const redis = new RedisMock();
  const queues = new RecordingQueues();
  const moduleRef = await Test.createTestingModule({ imports: [TestRootModule] })
    .overrideProvider(REDIS)
    .useValue(redis)
    .overrideProvider(QueueRegistry)
    .useValue(queues)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, bufferLogs: true });
  configureApp(app, { swagger: false });
  await app.init();

  const connection = app.get<Connection>(getConnectionToken());
  // Build every declared index up front so unique/partial indexes are enforced during the test.
  await Promise.all(Object.values(connection.models).map((m) => m.init()));

  const jwt = app.get(JwtService);
  let principalSeq = 0;

  return {
    app,
    connection,
    redis,
    queues,
    http: () => request(app.getHttpServer()),
    agent: () => request.agent(app.getHttpServer()),
    tokenFor: async (spec: PrincipalSpec = {}) => {
      principalSeq += 1;
      const id = spec.id ?? `${'0'.repeat(20)}${String(principalSeq).padStart(4, '0')}`;
      const userType = spec.userType ?? 'ADMIN';
      const defaultScope: RoleScope = { type: 'PLATFORM' as Extract<ScopeType, 'PLATFORM'> };
      FakePermissionResolver.principals.set(id, {
        roleCodes: spec.roleCodes ?? [],
        permissions: new Set(spec.permissions ?? []),
        scopes: spec.scopes ?? [defaultScope],
      });
      return jwt.signAsync({ sub: id, typ: userType, pv: 1 });
    },
    close: async () => {
      await connection.dropDatabase().catch(() => undefined);
      await app.close();
      redis.disconnect();
    },
  };
}
