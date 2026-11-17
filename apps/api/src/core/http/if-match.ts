import { DomainError } from '../errors/domain-error';

/** Parses an optional `If-Match: <version>` header used for optimistic locking (API.md §1.2). */
export function parseIfMatch(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 0)
    throw new DomainError('VALIDATION_FAILED', 'If-Match must be a version number.');
  return n;
}
