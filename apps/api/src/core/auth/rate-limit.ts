import { Injectable, Logger, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { DomainError } from '../errors/domain-error';
import { InjectRedis, type RedisClient } from '../redis/redis.module';

export interface RateLimitRule {
  /** Bucket name, e.g. 'otp-send'. */
  name: string;
  limit: number;
  windowSeconds: number;
  /**
   * What identifies the caller. The guard runs BEFORE authentication, so identities must come from
   * the request itself: the client IP, or a custom extractor (e.g. the mobile number in an OTP body).
   */
  by: 'ip' | ((req: Request) => string | undefined);
}

export const RATE_LIMIT = 'http:rateLimit';
export const SKIP_RATE_LIMIT = 'http:skipRateLimit';

/** Override the default limit for a route. Multiple rules may be stacked. */
export const RateLimit = (...rules: RateLimitRule[]): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT, rules);
export const SkipRateLimit = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_RATE_LIMIT, true);

/** Global default (SRS §10.3): 300 requests per minute per IP. */
export const DEFAULT_RATE_LIMIT: RateLimitRule = { name: 'global', limit: 300, windowSeconds: 60, by: 'ip' };

/** Fixed-window Redis rate limiter. Runs before authentication. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @InjectRedis() private readonly redis: RedisClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, targets)) return true;
    const rules = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(RATE_LIMIT, targets) ?? [
      DEFAULT_RATE_LIMIT,
    ];
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    for (const rule of rules) {
      const identity = this.identity(req, rule);
      const window = Math.floor(Date.now() / 1000 / rule.windowSeconds);
      const key = `rl:${rule.name}:${identity}:${window}`;
      let count: number;
      try {
        count = await this.redis.incr(key);
        if (count === 1) await this.redis.expire(key, rule.windowSeconds);
      } catch (err) {
        // Fail open: an unavailable cache must not take the whole API down. Auth-sensitive flows
        // (OTP) add their own database-backed limits (FR-AUTH-04).
        this.logger.warn({ err: (err as Error).message, rule: rule.name }, 'Rate limiter unavailable');
        continue;
      }
      if (count > rule.limit) {
        res.setHeader('Retry-After', String(rule.windowSeconds));
        throw new DomainError('RATE_LIMITED', 'Too many requests. Please try again later.');
      }
    }
    return true;
  }

  private identity(req: Request, rule: RateLimitRule): string {
    const ip = req.ip ?? 'unknown';
    if (rule.by === 'ip') return ip;
    return rule.by(req) ?? `ip:${ip}`;
  }
}
