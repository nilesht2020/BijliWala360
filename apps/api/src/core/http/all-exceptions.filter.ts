import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { REQUEST_ID_HEADER, type ApiFailure, type ErrorCode } from '@skillconnect/contracts';
import { DomainError } from '../errors/domain-error';
import { zodErrorToDomainError } from './zod';
import { requestIdOf } from './response-envelope.interceptor';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'STATE_CONFLICT',
  429: 'RATE_LIMITED',
};

interface MongoLikeError {
  code?: number;
  name?: string;
}

/** Converts every thrown value into the standard error envelope (ARCHITECTURE §6.10). */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = requestIdOf(req);

    const { status, body } = this.toResponse(exception);
    if (requestId) {
      body.requestId = requestId;
      res.setHeader(REQUEST_ID_HEADER, requestId);
    }

    if (status >= 500) {
      this.logger.error({ err: exception, requestId, path: req.url }, 'Unhandled error');
    }
    res.status(status).json(body);
  }

  toResponse(exception: unknown): { status: number; body: ApiFailure } {
    if (exception instanceof ZodError) exception = zodErrorToDomainError(exception);

    if (exception instanceof DomainError) {
      return {
        status: exception.status,
        body: {
          success: false,
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details ? { details: exception.details } : {}),
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode =
        STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED');
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : typeof (response as { message?: unknown }).message === 'string'
            ? (response as { message: string }).message
            : exception.message;
      return { status, body: { success: false, error: { code, message } } };
    }

    // Duplicate key from a unique index the service did not translate: treat as a state conflict.
    const mongo = exception as MongoLikeError;
    if (mongo?.code === 11000) {
      return {
        status: HttpStatus.CONFLICT,
        body: {
          success: false,
          error: { code: 'STATE_CONFLICT', message: 'A conflicting record already exists.' },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } },
    };
  }
}
