import { z } from 'zod';
import { addressSchema, mobileSchema, objectIdSchema, paginationQuerySchema, paiseSchema } from './common';
import { COMPANY_STATUSES, type CompanyStatus } from './enums';
import { gstinSchema, latLngSchema, panSchema } from './providers';

/* ================================================================ GST state codes */

/** GST state / union-territory codes (first two digits of a GSTIN). Used for place of supply. */
export const INDIAN_STATES = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
] as const;

const STATE_CODES = new Set<string>(INDIAN_STATES.map((s) => s.code));

export function stateNameOf(code: string): string | undefined {
  return INDIAN_STATES.find((s) => s.code === code)?.name;
}

export const stateCodeSchema = z.string().refine((c) => STATE_CODES.has(c), 'Choose a valid state');

/** An address whose GST state code is known (needed to decide CGST+SGST vs IGST). */
export const gstAddressSchema = addressSchema.extend({ stateCode: stateCodeSchema });
export type GstAddress = z.infer<typeof gstAddressSchema>;

/* ================================================================ companies (FR-CMP-01..04) */

export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

/** GSTIN = state code (2) + PAN (10) + entity (1) + 'Z' + checksum: both parts must agree. */
function checkGstin(
  v: {
    gstin?: string | undefined;
    pan?: string | undefined;
    billingAddress?: { stateCode: string } | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (!v.gstin) return;
  if (v.billingAddress && v.gstin.slice(0, 2) !== v.billingAddress.stateCode)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gstin'],
      message: 'The GSTIN does not belong to the billing state',
    });
  if (v.pan && v.gstin.slice(2, 12) !== v.pan)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gstin'],
      message: 'The GSTIN does not match the PAN',
    });
}

const companyFields = z
  .object({
    legalName: z.string().trim().min(2).max(150),
    pan: panSchema,
    gstin: gstinSchema.optional(),
    industry: z.string().trim().max(80).optional(),
    size: z.enum(COMPANY_SIZES).optional(),
    billingAddress: gstAddressSchema,
  })
  .strict();

export const companyCreateSchema = companyFields.superRefine(checkGstin);
export type CompanyCreateInput = z.infer<typeof companyCreateSchema>;

/** Legal name, PAN and GSTIN are locked once the company is verified (server-enforced). */
export const companyUpdateSchema = companyFields
  .omit({ pan: true })
  .partial()
  .strict()
  .superRefine(checkGstin);
export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>;

export const commercialTermsSchema = z
  .object({
    creditDays: z.number().int().min(0).max(180),
    creditLimitPaise: paiseSchema.nullable(),
    offlinePaymentAllowed: z.boolean(),
    advancePct: z.number().int().min(0).max(100),
  })
  .strict();
export type CommercialTerms = z.infer<typeof commercialTermsSchema>;

export const DEFAULT_COMMERCIAL_TERMS: CommercialTerms = {
  creditDays: 15,
  creditLimitPaise: null,
  offlinePaymentAllowed: true,
  advancePct: 0,
};

export const BLOCKABLE_PROVIDER_TYPES = ['PROFESSIONAL', 'VENDOR', 'VENDOR_WORKER'] as const;

export const blockedProvidersSchema = z
  .object({
    providers: z
      .array(
        z
          .object({
            type: z.enum(BLOCKABLE_PROVIDER_TYPES),
            id: objectIdSchema,
            reason: z.string().trim().max(300).optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type BlockedProvidersInput = z.infer<typeof blockedProvidersSchema>;

export interface CompanyView {
  id: string;
  legalName: string;
  panLast4: string;
  gstin?: string;
  industry?: string;
  size?: CompanySize;
  billingAddress: GstAddress;
  status: CompanyStatus;
  statusReason?: string;
  commercialTerms: CommercialTerms;
  blockedProviders: Array<{ type: (typeof BLOCKABLE_PROVIDER_TYPES)[number]; id: string; reason?: string }>;
  primaryContact?: { userId: string; name: string; mobile?: string };
  activeSiteCount: number;
  activatedAt?: string;
  createdAt: string;
  version: number;
}

export const companyListQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const companyStatusChangeSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/* ================================================================ sites */

export const siteInputSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    address: gstAddressSchema,
    location: latLngSchema,
    timezone: z.string().max(50).default('Asia/Kolkata'),
    contact: z.object({ name: z.string().trim().min(2).max(100), mobile: mobileSchema }).strict(),
    geofenceMeters: z.number().int().min(25).max(5000).optional(),
  })
  .strict();
export type SiteInput = z.input<typeof siteInputSchema>;

export const siteUpdateSchema = siteInputSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict();
export type SiteUpdateInput = z.input<typeof siteUpdateSchema>;

export interface SiteView {
  id: string;
  companyId: string;
  name: string;
  address: GstAddress;
  location: { lat: number; lng: number };
  timezone: string;
  contact: { name: string; mobile: string };
  geofenceMeters?: number;
  isActive: boolean;
}

/* ================================================================ company users (FR-CMP-03) */

export const COMPANY_ROLE_CODES = ['COMPANY_ADMIN', 'COMPANY_USER'] as const;
export type CompanyRoleCode = (typeof COMPANY_ROLE_CODES)[number];

export const companyUserInviteSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    mobile: mobileSchema,
    roleCode: z.enum(COMPANY_ROLE_CODES),
    siteIds: z.array(objectIdSchema).max(100).optional(),
  })
  .strict();
export type CompanyUserInviteInput = z.infer<typeof companyUserInviteSchema>;

export interface CompanyUserView {
  userId: string;
  name: string;
  mobile?: string;
  roleCode: CompanyRoleCode;
  siteIds?: string[];
  status: string;
  isPrimaryContact: boolean;
  isYou: boolean;
}
