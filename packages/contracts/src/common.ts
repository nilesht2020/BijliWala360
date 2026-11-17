import { z } from 'zod';

/** 24-hex MongoDB ObjectId as a string. */
export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid id');
export type ObjectIdString = z.infer<typeof objectIdSchema>;

/** Money is always an integer number of paise (BR-FIN-05). */
export const paiseSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Calendar date in the site's local timezone: YYYY-MM-DD. */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Invalid calendar date');

/** Minutes from local midnight (0..1439). */
export const minuteOfDaySchema = z.number().int().min(0).max(1439);

export const shiftSchema = z.object({
  startMin: minuteOfDaySchema,
  endMin: minuteOfDaySchema,
});
export type Shift = z.infer<typeof shiftSchema>;

/** E.164 Indian mobile by default; other E.164 numbers are accepted for future expansion. */
export const mobileSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Must be an E.164 mobile number, e.g. +919812345678');

export const geoPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
});
export type GeoPoint = z.infer<typeof geoPointSchema>;

export const addressSchema = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(1).max(100),
  stateCode: z.string().length(2).optional(),
  pincode: z.string().regex(/^\d{6}$/, 'Must be a 6-digit pincode'),
  country: z.string().default('IN'),
});
export type Address = z.infer<typeof addressSchema>;

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  sort: z.string().max(50).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const cursorQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(50),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface CursorMeta {
  nextCursor: string | null;
}

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

export interface CursorPage<T> {
  items: T[];
  meta: CursorMeta;
}

export interface ApiErrorDetail {
  path?: string;
  field?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PageMeta | CursorMeta;
}

export interface ApiFailure {
  success: false;
  error: { code: string; message: string; details?: ApiErrorDetail[] };
  requestId?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REQUEST_ID_HEADER = 'x-request-id';
