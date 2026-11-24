import { httpStatusFor, type ApiErrorDetail, type ErrorCode } from '@bijliwala/contracts';

/**
 * Base class for every expected business/technical error. The global exception filter maps it to
 * the standard error envelope using the status registered for its code in the contracts package.
 */
export class DomainError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'DomainError';
    this.status = httpStatusFor(code);
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id?: string) {
    super('NOT_FOUND', id ? `${entity} ${id} was not found.` : `${entity} was not found.`);
  }
}

export class StateConflictError extends DomainError {
  constructor(message = 'The resource was modified or is no longer in the expected state.') {
    super('STATE_CONFLICT', message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to perform this action.') {
    super('FORBIDDEN', message);
  }
}
