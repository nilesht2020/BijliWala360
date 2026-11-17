import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig } from '../config/app-config';

export const REDIS = Symbol('REDIS');
export type RedisClient = Redis;

/** Injects the shared ioredis client (cache, rate limiting, pub/sub publishing). */
export const InjectRedis = (): ParameterDecorator => Inject(REDIS);

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => undefined);
  }
}

/**
 * Shared client for cache / rate limiting: fails fast when Redis is unavailable so HTTP requests
 * degrade instead of hanging (BullMQ uses its own connections; see QueueRegistry). Connection
 * errors are logged at most once per minute instead of as unhandled error events.
 */
export function createSharedRedis(url: string): Redis {
  const logger = new Logger('Redis');
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    // Fail commands immediately while disconnected instead of queueing them until reconnect:
    // callers (rate limiter, caches) already degrade gracefully on errors.
    enableOfflineQueue: false,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  let lastLoggedAt = 0;
  client.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt > 60_000) {
      lastLoggedAt = now;
      logger.warn(`Redis unavailable: ${err.message}`);
    }
  });
  client.on('ready', () => {
    if (lastLoggedAt > 0) logger.log('Redis connection restored');
    lastLoggedAt = 0;
  });
  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => createSharedRedis(config.env.REDIS_URL),
    },
    RedisShutdown,
  ],
  exports: [REDIS],
})
export class RedisModule {}
