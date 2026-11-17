import { Controller, Get, HttpCode, HttpStatus, Module, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/mongoose';
import type { Response } from 'express';
import type { Connection } from 'mongoose';
import { Public } from '../auth/decorators';
import { SkipRateLimit } from '../auth/rate-limit';
import { RawResponse } from '../http/response-envelope.interceptor';
import { InjectRedis, type RedisClient } from '../redis/redis.module';

type CheckStatus = 'up' | 'down';

/** Liveness/readiness probes (SRS §10.6). Served outside the /api/v1 prefix. */
@ApiExcludeController()
@Controller('health')
@Public()
@SkipRateLimit()
@RawResponse()
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    @InjectRedis() private readonly redis: RedisClient,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: string; checks: Record<string, CheckStatus> }> {
    const [mongo, redis] = await Promise.all([this.checkMongo(), this.checkRedis()]);
    const checks = { mongo, redis };
    const ok = Object.values(checks).every((s) => s === 'up');
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', checks };
  }

  private async checkMongo(): Promise<CheckStatus> {
    try {
      await this.mongo.db?.admin().ping();
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<CheckStatus> {
    try {
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000).unref());
      return (await Promise.race([this.redis.ping(), timeout])) === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
