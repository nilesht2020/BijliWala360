import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@skillconnect/contracts';
import { requestIdOf } from './response-envelope.interceptor';

/**
 * NoSQL-injection guard (SRS §10.3): rejects any request whose body or query contains a key with
 * `$` or `.` anywhere in it. "Anywhere" also covers bracket-notation query keys such as
 * `page[$gt]`, which Express 5's simple query parser keeps as a flat key. Strict Zod schemas reject
 * unknown keys afterwards as well.
 */
export function findForbiddenKey(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key.includes('$') || key.includes('.')) return childPath;
      const hit = findForbiddenKey(child, childPath);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Registered as Nest middleware (after the request-id/logging middleware) so that rejections carry
 * the same `requestId` as every other error response.
 */
@Injectable()
export class SanitizeMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const hit = findForbiddenKey(req.body) ?? findForbiddenKey(req.query);
    if (!hit) {
      next();
      return;
    }
    const requestId = requestIdOf(req);
    if (requestId) res.setHeader(REQUEST_ID_HEADER, requestId);
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request contains a forbidden key.',
        details: [{ path: hit }],
      },
      ...(requestId ? { requestId } : {}),
    });
  }
}
