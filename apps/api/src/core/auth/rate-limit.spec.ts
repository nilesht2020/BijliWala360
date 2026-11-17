import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RedisClient } from '../redis/redis.module';
import { RateLimitGuard } from './rate-limit';

function httpContext(): ExecutionContext {
  const req = { ip: '10.0.0.1', headers: {} };
  const res = { setHeader: jest.fn() };
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  it('fails open when Redis is unavailable', async () => {
    const redis = { incr: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')), expire: jest.fn() };
    const guard = new RateLimitGuard(new Reflector(), redis as unknown as RedisClient);
    await expect(guard.canActivate(httpContext())).resolves.toBe(true);
  });

  it('blocks once the default limit is exceeded', async () => {
    let n = 300;
    const redis = { incr: jest.fn(async () => ++n), expire: jest.fn() };
    const guard = new RateLimitGuard(new Reflector(), redis as unknown as RedisClient);
    await expect(guard.canActivate(httpContext())).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
