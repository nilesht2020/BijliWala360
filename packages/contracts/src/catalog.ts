import { z } from 'zod';
import { localDateSchema, objectIdSchema, paiseSchema } from './common';
import { DOCUMENT_STATUSES, PROVIDER_TYPES, type DocumentStatus, type ProviderType } from './enums';

/* ================================================================ service categories & skills (§4.4) */

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase words separated by hyphens')
  .max(80);

export const categoryCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    slug: slugSchema.optional(),
    parentId: objectIdSchema.nullable().default(null),
    description: z.string().trim().max(500).optional(),
    imageUrl: z.string().url().max(500).optional(),
    icon: z.string().max(50).optional(),
    displayOrder: z.number().int().min(0).max(10_000).default(0),
    seo: z
      .object({ title: z.string().max(70).optional(), description: z.string().max(160).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;

export const categoryUpdateSchema = categoryCreateSchema
  .omit({ parentId: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict();
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;

export interface CategoryView {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  level: 1 | 2 | 3;
  description?: string;
  imageUrl?: string;
  icon?: string;
  displayOrder: number;
  isActive: boolean;
  children?: CategoryView[];
}

export const skillCreateSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use UPPER_SNAKE_CASE'),
    name: z.string().trim().min(2).max(80),
    categoryIds: z.array(objectIdSchema).min(1, 'Choose at least one category').max(10),
    requiredDocTypeCodes: z.array(z.string().max(40)).max(10).default([]),
    sacCode: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional(),
    isActive: z.boolean().default(true),
  })
  .strict();
export type SkillCreateInput = z.infer<typeof skillCreateSchema>;
export const skillUpdateSchema = skillCreateSchema.omit({ code: true }).partial().strict();
export type SkillUpdateInput = z.infer<typeof skillUpdateSchema>;

export interface SkillView {
  id: string;
  code: string;
  name: string;
  categoryIds: string[];
  requiredDocTypeCodes: string[];
  sacCode?: string;
  isActive: boolean;
}

export interface PublicCategoryDetail {
  category: CategoryView;
  children: CategoryView[];
  skills: SkillView[];
  breadcrumbs: Array<Pick<CategoryView, 'id' | 'name' | 'slug'>>;
}

/* ================================================================ documents (§4.7) */

export const DOCUMENT_OWNER_TYPES = [
  'PROFESSIONAL',
  'VENDOR',
  'VENDOR_WORKER',
  'COMPANY',
  'REGISTRATION_PAYMENT',
] as const;
export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number];

export const ALLOWED_UPLOAD_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;

export const documentTypeSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use UPPER_SNAKE_CASE'),
    name: z.string().trim().min(2).max(80),
    description: z.string().max(300).optional(),
    ownerTypes: z.array(z.enum(DOCUMENT_OWNER_TYPES)).min(1),
    allowedMime: z.array(z.enum(ALLOWED_UPLOAD_MIME)).min(1),
    maxSizeBytes: z
      .number()
      .int()
      .min(10_000)
      .max(20 * 1024 * 1024),
    hasExpiry: z.boolean().default(false),
    captureNumber: z.boolean().default(false),
    numberPattern: z.string().max(200).optional(),
    isSensitive: z.boolean().default(false),
    reminderDaysBefore: z.array(z.number().int().min(1).max(365)).max(5).default([30, 7]),
    isActive: z.boolean().default(true),
  })
  .strict();
export type DocumentTypeInput = z.infer<typeof documentTypeSchema>;
export interface DocumentTypeView extends DocumentTypeInput {
  id: string;
}

export const uploadIntentSchema = z
  .object({
    typeCode: z.string().max(40),
    owner: z.object({ type: z.enum(DOCUMENT_OWNER_TYPES), id: objectIdSchema }).strict(),
    fileName: z.string().trim().min(1).max(200),
    mime: z.string().max(100),
    sizeBytes: z.number().int().min(1),
    number: z.string().trim().max(40).optional(),
    expiresOn: localDateSchema.optional(),
  })
  .strict();
export type UploadIntentInput = z.infer<typeof uploadIntentSchema>;

export interface UploadIntentResponse {
  documentId: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

export const documentReviewSchema = z
  .object({ decision: z.enum(['VERIFIED', 'REJECTED']), comment: z.string().trim().max(500).optional() })
  .strict()
  .refine((v) => v.decision === 'VERIFIED' || (v.comment?.length ?? 0) >= 3, {
    path: ['comment'],
    message: 'Explain why the document is rejected',
  });
export type DocumentReviewInput = z.infer<typeof documentReviewSchema>;

export const documentListQuerySchema = z
  .object({
    ownerType: z.enum(DOCUMENT_OWNER_TYPES),
    ownerId: objectIdSchema,
    includeHistory: z.enum(['true', 'false']).optional(),
  })
  .strict();

export interface DocumentView {
  id: string;
  typeCode: string;
  typeName?: string;
  owner: { type: DocumentOwnerType; id: string };
  fileName: string;
  mime: string;
  sizeBytes: number;
  status: DocumentStatus;
  versionNo: number;
  numberLast4?: string;
  expiresOn?: string;
  review?: { decision: 'VERIFIED' | 'REJECTED'; comment?: string; at: string };
  rejectionReason?: string;
  createdAt: string;
}

export const ACTIVE_DOCUMENT_STATUSES: readonly DocumentStatus[] = ['UPLOADED', 'VERIFIED'];
export { DOCUMENT_STATUSES };

/* ================================================================ registration plans (§4.5) */

export const refundPolicySchema = z
  .object({
    onRejection: z.enum(['FULL', 'PARTIAL', 'NONE']),
    partialPct: z.number().int().min(1).max(99).optional(),
  })
  .strict()
  .refine((p) => p.onRejection !== 'PARTIAL' || p.partialPct !== undefined, {
    path: ['partialPct'],
    message: 'Set the refund percentage',
  });

export const registrationPlanSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/, 'Use UPPER_SNAKE_CASE'),
    name: z.string().trim().min(2).max(80),
    providerType: z.enum(PROVIDER_TYPES),
    description: z.string().max(500).optional(),
    feePaise: paiseSchema,
    gstRateBp: z.number().int().min(0).max(2800),
    sacCode: z.string().regex(/^\d{4,8}$/),
    features: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
    maxWorkers: z.number().int().min(1).max(100_000).nullable().default(null),
    mandatoryDocTypeCodes: z.array(z.string().max(40)).max(15).default([]),
    gstinRequired: z.boolean().default(false),
    offlinePaymentAllowed: z.boolean().default(true),
    refundPolicy: refundPolicySchema,
    isActive: z.boolean().default(true),
    displayOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict()
  .refine((p) => p.providerType === 'VENDOR' || p.maxWorkers === null, {
    path: ['maxWorkers'],
    message: 'Only vendor plans have a worker limit',
  });
export type RegistrationPlanInput = z.infer<typeof registrationPlanSchema>;

export interface RegistrationPlanView extends RegistrationPlanInput {
  id: string;
  taxPaise: number;
  totalPaise: number;
  version: number;
}

export type { ProviderType };
