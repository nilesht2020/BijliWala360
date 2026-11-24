import {
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import type { Request } from 'express';
import type { Model } from 'mongoose';
import { createHash } from 'node:crypto';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { IDEMPOTENCY_HEADER } from '@bijliwala/contracts';
import type { AuthUser } from '../auth/auth.types';
import { IDEMPOTENCY_MODEL, type IdempotencyDoc } from '../database/core.schemas';
import { DomainError } from '../errors/domain-error';

export const IDEMPOTENT = 'http:idempotent';
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface IdempotentOptions {
  /** When true (default), requests without an Idempotency-Key header are rejected. */
  required?: boolean;
}

/** Marks a route as idempotent (API.md 🔁). Apply together with `@UseInterceptors(IdempotencyInterceptor)`. */
export const Idempotent = (options: IdempotentOptions = {}): MethodDecorator =>
  SetMetadata(IDEMPOTENT, { required: true, ...options });

/** Deterministic JSON (sorted keys) so semantically equal payloads hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function hashRequest(body: unknown, params: unknown): string {
  return createHash('sha256').update(stableStringify({ body, params })).digest('hex');
}

/**
 * Idempotency-Key handling (ARCHITECTURE §5, SRS §10.5):
 *  - first request: reserve key as IN_PROGRESS, run handler, store the response as COMPLETED;
 *  - replay with same payload: return the stored response without re-running the handler;
 *  - same key + different payload: 422 IDEMPOTENCY_KEY_REUSED;
 *  - concurrent duplicate while in progress: 409 REQUEST_IN_PROGRESS;
 *  - handler error: key released so the client may retry with the same key.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @InjectModel(IDEMPOTENCY_MODEL) private readonly keys: Model<IdempotencyDoc>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return from(this.handle(context, next));
  }

  private async handle(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const options = this.reflector.get<Required<IdempotentOptions> | undefined>(
      IDEMPOTENT,
      context.getHandler(),
    );
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const key = req.header(IDEMPOTENCY_HEADER);

    if (!options || !key) {
      if (options?.required) {
        throw new DomainError(
          'IDEMPOTENCY_KEY_REQUIRED',
          'This operation requires an Idempotency-Key header.',
        );
      }
      return lastValueFrom(next.handle(), { defaultValue: undefined });
    }
    if (!KEY_PATTERN.test(key)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-].',
      );
    }

    const userId = req.user?.id ?? `anon:${req.ip ?? 'unknown'}`;
    const route = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
    const requestHash = hashRequest(req.body, req.params);
    const filter = { key, userId, route };

    try {
      await this.keys.create({
        ...filter,
        requestHash,
        status: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + KEY_TTL_MS),
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const existing = await this.keys.findOne(filter).lean().exec();
      if (!existing) throw new DomainError('REQUEST_IN_PROGRESS', 'Please retry the request.');
      if (existing.requestHash !== requestHash) {
        throw new DomainError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used with a different request.',
        );
      }
      if (existing.status === 'IN_PROGRESS') {
        throw new DomainError('REQUEST_IN_PROGRESS', 'An identical request is still being processed.');
      }
      return existing.responseBody ?? null;
    }

    try {
      const result: unknown = await lastValueFrom(next.handle(), { defaultValue: undefined });
      // Persist exactly what the client will receive (ObjectIds/Dates serialised to JSON).
      const serialisable: unknown = result === undefined ? null : JSON.parse(JSON.stringify(result));
      await this.keys.updateOne(filter, { $set: { status: 'COMPLETED', responseBody: serialisable } });
      return serialisable;
    } catch (err) {
      await this.keys.deleteOne({ ...filter, status: 'IN_PROGRESS' }).catch(() => undefined);
      throw err;
    }
  }
}
