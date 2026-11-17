import {
  applyDecorators,
  BadRequestException,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiQuery } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { DomainError } from '../errors/domain-error';

/**
 * Minimal, dependency-free Zod <-> NestJS bridge (ARCHITECTURE D-01).
 * A DTO class created with `createZodDto(schema)` carries its schema as a static property; the
 * global ZodValidationPipe validates any argument whose metatype exposes that schema.
 */
export interface ZodDtoClass<S extends ZodTypeAny = ZodTypeAny> {
  new (): z.infer<S>;
  readonly zodSchema: S;
}

export function createZodDto<S extends ZodTypeAny>(schema: S): ZodDtoClass<S> {
  class ZodDto {
    static readonly zodSchema = schema;
  }
  return ZodDto as unknown as ZodDtoClass<S>;
}

function hasZodSchema(metatype: unknown): metatype is ZodDtoClass {
  return typeof metatype === 'function' && 'zodSchema' in metatype;
}

export function zodErrorToDomainError(error: ZodError): DomainError {
  return new DomainError(
    'VALIDATION_FAILED',
    'Request validation failed.',
    error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
  );
}

export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (!hasZodSchema(metadata.metatype)) return value;
    const result = metadata.metatype.zodSchema.safeParse(value);
    if (!result.success) throw zodErrorToDomainError(result.error);
    return result.data;
  }
}

/** Parse arbitrary input with a schema inside services, raising the standard validation error. */
export function parseWith<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  try {
    return schema.parse(value) as z.infer<S>;
  } catch (e) {
    if (e instanceof ZodError) throw zodErrorToDomainError(e);
    throw new BadRequestException();
  }
}

export function toOpenApiSchema(schema: ZodTypeAny): SchemaObject {
  const json = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json as SchemaObject;
}

/** Swagger: document a Zod DTO as the request body. */
export function ApiZodBody(dto: ZodDtoClass): MethodDecorator {
  return applyDecorators(ApiBody({ schema: toOpenApiSchema(dto.zodSchema) }));
}

/** Swagger: document each property of a Zod object DTO as a query parameter. */
export function ApiZodQuery(dto: ZodDtoClass): MethodDecorator {
  const schema = toOpenApiSchema(dto.zodSchema);
  const props = (schema.properties ?? {}) as Record<string, SchemaObject>;
  const required = new Set(schema.required ?? []);
  return applyDecorators(
    ...Object.entries(props).map(([name, prop]) =>
      ApiQuery({ name, required: required.has(name), schema: prop }),
    ),
  );
}

/** Swagger: document the `data` payload of the standard success envelope. */
export function ApiZodOk(schema: ZodTypeAny, description = 'OK'): MethodDecorator {
  return applyDecorators(
    ApiOkResponse({
      description,
      schema: {
        type: 'object',
        properties: { success: { type: 'boolean', example: true }, data: toOpenApiSchema(schema) },
      },
    }),
  );
}
