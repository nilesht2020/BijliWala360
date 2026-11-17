import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DomainError } from '../errors/domain-error';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { PagedResult, wrap } from './response-envelope.interceptor';
import { findForbiddenKey } from './sanitize';
import { createZodDto, toOpenApiSchema, ZodValidationPipe } from './zod';

describe('response envelope', () => {
  it('wraps plain data', () => {
    expect(wrap({ id: 1 })).toEqual({ success: true, data: { id: 1 } });
  });

  it('wraps undefined as null', () => {
    expect(wrap(undefined)).toEqual({ success: true, data: null });
  });

  it('lifts pagination meta', () => {
    const body = wrap(new PagedResult([1, 2], { page: 1, pageSize: 2, total: 5 }));
    expect(body).toEqual({ success: true, data: [1, 2], meta: { page: 1, pageSize: 2, total: 5 } });
  });
});

describe('AllExceptionsFilter.toResponse', () => {
  const filter = new AllExceptionsFilter();

  it('maps DomainError using the contract status', () => {
    const { status, body } = filter.toResponse(
      new DomainError('ALLOCATION_CAPACITY_EXCEEDED', 'No slots', [{ lineId: 'L1' }]),
    );
    expect(status).toBe(422);
    expect(body.error).toEqual({
      code: 'ALLOCATION_CAPACITY_EXCEEDED',
      message: 'No slots',
      details: [{ lineId: 'L1' }],
    });
  });

  it('maps ZodError to VALIDATION_FAILED with paths', () => {
    const result = z.object({ a: z.number() }).safeParse({ a: 'x' });
    if (result.success) throw new Error('expected failure');
    const { status, body } = filter.toResponse(result.error);
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details?.[0]?.path).toBe('a');
  });

  it('maps Nest HttpExceptions', () => {
    expect(filter.toResponse(new NotFoundException()).body.error.code).toBe('NOT_FOUND');
    expect(filter.toResponse(new HttpException('slow down', HttpStatus.TOO_MANY_REQUESTS)).status).toBe(429);
  });

  it('maps duplicate-key errors to 409 without leaking internals', () => {
    const { status, body } = filter.toResponse(
      Object.assign(new Error('E11000 dup key: secret'), { code: 11000 }),
    );
    expect(status).toBe(409);
    expect(body.error.message).not.toContain('secret');
  });

  it('hides unknown errors behind a generic 500', () => {
    const { status, body } = filter.toResponse(new Error('db password is hunter2'));
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
  });
});

describe('findForbiddenKey', () => {
  it.each([
    [{ a: 1, b: { c: [1, 2] } }, null],
    [{ $where: '1' }, '$where'],
    [{ filter: { status: { $ne: 'X' } } }, 'filter.status.$ne'],
    [{ list: [{ ok: 1 }, { 'a.b': 1 }] }, 'list[1].a.b'],
    [{ 'page[$gt]': '1' }, 'page[$gt]'],
  ])('%j -> %s', (input, expected) => {
    expect(findForbiddenKey(input)).toBe(expected);
  });
});

describe('ZodValidationPipe', () => {
  const Dto = createZodDto(
    z.object({ name: z.string().min(2), count: z.number().int().default(1) }).strict(),
  );
  const pipe = new ZodValidationPipe();

  it('parses and applies defaults for zod DTOs', () => {
    expect(pipe.transform({ name: 'ab' }, { type: 'body', metatype: Dto })).toEqual({ name: 'ab', count: 1 });
  });

  it('rejects unknown keys (strict) with VALIDATION_FAILED', () => {
    expect(() => pipe.transform({ name: 'ab', role: 'admin' }, { type: 'body', metatype: Dto })).toThrow(
      DomainError,
    );
  });

  it('passes through non-zod metatypes', () => {
    expect(pipe.transform('42', { type: 'param', metatype: String })).toBe('42');
  });

  it('produces an OpenAPI schema', () => {
    const schema = toOpenApiSchema(Dto.zodSchema);
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual(['name', 'count']);
  });
});
