import {
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { REQUEST_ID_HEADER, type ApiSuccess, type CursorMeta, type PageMeta } from '@skillconnect/contracts';

export const RAW_RESPONSE = 'http:rawResponse';
/** Skip the envelope (webhooks, health checks, redirects). */
export const RawResponse = (): MethodDecorator & ClassDecorator => SetMetadata(RAW_RESPONSE, true);

/** Return from a controller to have `meta` lifted into the envelope. */
export class PagedResult<T> {
  constructor(
    readonly items: T[],
    readonly meta: PageMeta | CursorMeta,
  ) {}
}

export function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = requestIdOf(req);
    if (requestId) res.setHeader(REQUEST_ID_HEADER, requestId);

    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) return next.handle();

    return next.handle().pipe(map((body: unknown) => wrap(body)));
  }
}

export function wrap(body: unknown): ApiSuccess<unknown> {
  if (body instanceof PagedResult) {
    return { success: true, data: body.items, meta: body.meta };
  }
  return { success: true, data: body ?? null };
}
