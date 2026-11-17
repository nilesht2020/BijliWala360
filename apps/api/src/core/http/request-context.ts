import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuditContext } from '../audit/audit.service';
import { requestIdOf } from './response-envelope.interceptor';

export function requestContextOf(req: Request): AuditContext {
  const ua = req.headers['user-agent'];
  return {
    requestId: requestIdOf(req),
    ip: req.ip,
    userAgent: typeof ua === 'string' ? ua.slice(0, 300) : undefined,
  };
}

/** Injects `{ requestId, ip, userAgent }` for audit entries and session records. */
export const ReqContext = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuditContext =>
    requestContextOf(ctx.switchToHttp().getRequest<Request>()),
);
