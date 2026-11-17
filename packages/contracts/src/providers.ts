import { z } from 'zod';
import {
  addressSchema,
  localDateSchema,
  minuteOfDaySchema,
  mobileSchema,
  objectIdSchema,
  paginationQuerySchema,
} from './common';
import { PROVIDER_STATUSES, WORKER_STATUSES, type ProviderStatus, type WorkerStatus } from './enums';

/* ================================================================ identity (FR-VWK-04, FR-DOC-05) */

export const ID_TYPES = ['PAN', 'AADHAAR', 'VOTER_ID', 'DRIVING_LICENCE', 'PASSPORT'] as const;
export type IdType = (typeof ID_TYPES)[number];

const ID_PATTERNS: Record<IdType, RegExp> = {
  PAN: /^[A-Z]{5}\d{4}[A-Z]$/,
  AADHAAR: /^\d{12}$/,
  VOTER_ID: /^[A-Z]{3}\d{7}$/,
  DRIVING_LICENCE: /^[A-Z]{2}\d{2}[ -]?\d{4}\d{7}$/,
  PASSPORT: /^[A-Z]\d{7}$/,
};

export function normaliseIdNumber(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase();
}

export const identitySchema = z
  .object({ idType: z.enum(ID_TYPES), idNumber: z.string().trim().min(5).max(20) })
  .strict()
  .refine((v) => ID_PATTERNS[v.idType].test(normaliseIdNumber(v.idNumber)), {
    path: ['idNumber'],
    message: 'This number does not match the format of the selected ID',
  });
export type IdentityInput = z.infer<typeof identitySchema>;

export const latLngSchema = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .strict();
export type LatLng = z.infer<typeof latLngSchema>;

export const PROFICIENCIES = ['BEGINNER', 'INTERMEDIATE', 'EXPERT'] as const;
export type Proficiency = (typeof PROFICIENCIES)[number];

export const providerSkillSchema = z
  .object({
    skillId: objectIdSchema,
    proficiency: z.enum(PROFICIENCIES),
    years: z.number().int().min(0).max(60),
  })
  .strict();

export const weeklySlotSchema = z
  .object({ dow: z.number().int().min(0).max(6), startMin: minuteOfDaySchema, endMin: minuteOfDaySchema })
  .strict();

export const availabilitySchema = z
  .object({ weekly: z.array(weeklySlotSchema).max(21), blockedDates: z.array(localDateSchema).max(366) })
  .strict();
export type AvailabilityInput = z.infer<typeof availabilitySchema>;

export const bankDetailsSchema = z
  .object({
    accountNumber: z.string().regex(/^\d{9,18}$/, 'Account numbers have 9-18 digits'),
    ifsc: z
      .string()
      .toUpperCase()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code'),
    holderName: z.string().trim().min(2).max(100),
  })
  .strict();
export type BankDetailsInput = z.infer<typeof bankDetailsSchema>;

/* ================================================================ professionals (§4.1) */

export const professionalProfileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    dob: localDateSchema,
    gender: z.enum(['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED']).optional(),
    address: addressSchema,
    serviceLocation: latLngSchema,
    radiusKm: z.number().min(1).max(200),
    languages: z.array(z.string().trim().min(2).max(30)).max(10),
    experienceYears: z.number().int().min(0).max(60),
    categoryIds: z.array(objectIdSchema).max(10),
    identity: identitySchema,
  })
  .strict();
export const professionalUpdateSchema = professionalProfileSchema.partial().strict();
export type ProfessionalUpdateInput = z.infer<typeof professionalUpdateSchema>;

export const professionalSkillsSchema = z
  .object({ skills: z.array(providerSkillSchema).min(1).max(15) })
  .strict();

export interface ProviderSkillView {
  skillId: string;
  skillName?: string;
  proficiency: Proficiency;
  years: number;
  verification: 'PENDING' | 'VERIFIED' | 'REJECTED';
}

export interface ProfessionalView {
  id: string;
  userId: string;
  fullName: string;
  dob?: string;
  gender?: string;
  address?: z.infer<typeof addressSchema>;
  serviceLocation?: LatLng;
  radiusKm?: number;
  languages: string[];
  experienceYears?: number;
  categoryIds: string[];
  identity?: { idType: IdType; idLast4: string };
  skills: ProviderSkillView[];
  availability: AvailabilityInput;
  bank?: { accountLast4: string; ifsc: string; holderName: string };
  status: ProviderStatus;
  completion: { percent: number; missing: string[] };
  isMatchable: boolean;
  createdAt: string;
}

/* ================================================================ vendors (§4.2) */

export const ENTITY_TYPES = [
  'PROPRIETORSHIP',
  'PARTNERSHIP',
  'LLP',
  'PVT_LTD',
  'PUBLIC_LTD',
  'OTHER',
] as const;
export const gstinSchema = z
  .string()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN');
export const panSchema = z
  .string()
  .toUpperCase()
  .regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Enter a valid PAN');

export const operatingLocationSchema = z
  .object({
    label: z.string().trim().min(2).max(60),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radiusKm: z.number().min(1).max(500),
  })
  .strict();

export const vendorContactSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    mobile: mobileSchema,
    email: z.string().email().optional(),
    designation: z.string().max(60).optional(),
  })
  .strict();

export const vendorCreateSchema = z
  .object({
    legalName: z.string().trim().min(2).max(150),
    tradeName: z.string().trim().max(150).optional(),
    entityType: z.enum(ENTITY_TYPES),
    pan: panSchema,
    gstin: gstinSchema.optional(),
    registeredAddress: addressSchema,
  })
  .strict();
export type VendorCreateInput = z.infer<typeof vendorCreateSchema>;

export const vendorUpdateSchema = z
  .object({
    legalName: z.string().trim().min(2).max(150),
    tradeName: z.string().trim().max(150),
    entityType: z.enum(ENTITY_TYPES),
    gstin: gstinSchema,
    registeredAddress: addressSchema,
    categoryIds: z.array(objectIdSchema).max(20),
    operatingLocations: z.array(operatingLocationSchema).min(1).max(20),
    contacts: z.array(vendorContactSchema).min(1).max(10),
  })
  .partial()
  .strict();
export type VendorUpdateInput = z.infer<typeof vendorUpdateSchema>;

export interface VendorView {
  id: string;
  legalName: string;
  tradeName?: string;
  entityType: (typeof ENTITY_TYPES)[number];
  panLast4: string;
  gstin?: string;
  registeredAddress: z.infer<typeof addressSchema>;
  categoryIds: string[];
  operatingLocations: Array<z.infer<typeof operatingLocationSchema>>;
  contacts: Array<z.infer<typeof vendorContactSchema>>;
  bank?: { accountLast4: string; ifsc: string; holderName: string };
  status: ProviderStatus;
  workerCap: number | null;
  activeWorkerCount: number;
  completion: { percent: number; missing: string[] };
  isMatchable: boolean;
  createdAt: string;
}

export const addVendorAdminSchema = z.object({ mobile: mobileSchema }).strict();

/* ================================================================ vendor workers (§4.3) */

export const workerCreateSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    mobile: mobileSchema.optional(),
    identity: identitySchema,
    experienceYears: z.number().int().min(0).max(60),
    skills: z.array(providerSkillSchema).min(1).max(10),
    baseLocation: latLngSchema,
  })
  .strict();
export type WorkerCreateInput = z.infer<typeof workerCreateSchema>;

export const workerUpdateSchema = workerCreateSchema
  .omit({ identity: true })
  .partial()
  .extend({ availability: availabilitySchema.optional() })
  .strict();
export type WorkerUpdateInput = z.infer<typeof workerUpdateSchema>;

export const workerVerifySchema = z
  .object({ decision: z.enum(['APPROVED', 'REJECTED']), comment: z.string().trim().max(500).optional() })
  .strict()
  .refine((v) => v.decision === 'APPROVED' || (v.comment?.length ?? 0) >= 3, {
    path: ['comment'],
    message: 'Give a reason',
  });

export interface WorkerView {
  id: string;
  vendorId: string;
  fullName: string;
  mobile?: string;
  identity: { idType: IdType; idLast4: string };
  experienceYears: number;
  skills: ProviderSkillView[];
  baseLocation: LatLng;
  status: WorkerStatus;
  isMatchable: boolean;
  review?: { decision: string; comment?: string; at: string };
  createdAt: string;
}

export const workerListQuerySchema = paginationQuerySchema
  .extend({ status: z.enum(WORKER_STATUSES).optional() })
  .strict();

export const providerListQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(PROVIDER_STATUSES).optional(),
    q: z.string().trim().max(100).optional(),
    skillId: objectIdSchema.optional(),
  })
  .strict();

export const providerStatusChangeSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const identityConflictResolveSchema = z.object({ note: z.string().trim().min(3).max(500) }).strict();

export interface IdentityConflictView {
  id: string;
  attemptedRole: { type: 'PROFESSIONAL' | 'VENDOR_WORKER'; vendorId?: string; refId?: string; name: string };
  existingRole?: { type: 'PROFESSIONAL' | 'VENDOR_WORKER'; vendorId?: string; refId?: string };
  matchedOn: Array<'ID' | 'MOBILE'>;
  status: 'OPEN' | 'RESOLVED';
  note?: string;
  createdAt: string;
}
