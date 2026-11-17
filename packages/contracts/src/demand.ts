import { z } from 'zod';
import {
  localDateSchema,
  mobileSchema,
  objectIdSchema,
  paginationQuerySchema,
  paiseSchema,
  shiftSchema,
} from './common';
import { companyCreateSchema, siteInputSchema, type GstAddress } from './companies';
import { ENQUIRY_STATUSES, QUOTATION_STATUSES, type EnquiryStatus, type QuotationStatus } from './enums';
import type { SupplyType } from './tax';

/* ================================================================ shared schedule parts */

export const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1, 'Choose at least one working day')
  .max(7)
  .refine((d) => new Set(d).size === d.length, 'Each day may appear once')
  .transform((d) => [...d].sort((a, b) => a - b));

export const workShiftSchema = shiftSchema.refine((s) => s.startMin !== s.endMin, {
  message: 'The shift must start and end at different times',
  path: ['endMin'],
});

/* ================================================================ enquiries (FR-ENQ-01..04) */

export const ENQUIRY_SOURCES = ['COMPANY', 'PUBLIC_LEAD', 'ADMIN'] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCES)[number];

export const enquiryLineSchema = z
  .object({
    skillId: objectIdSchema,
    headcount: z.number().int().min(1).max(500),
    minExperienceYears: z.number().int().min(0).max(40).optional(),
    notes: z.string().trim().max(300).optional(),
  })
  .strict();

export const enquiryScheduleSchema = z
  .object({
    startDate: localDateSchema,
    endDate: localDateSchema.optional(),
    durationDays: z.number().int().min(1).max(1095).optional(),
    weekdays: weekdaysSchema,
    shift: workShiftSchema,
  })
  .strict()
  .refine((s) => !s.endDate || s.endDate >= s.startDate, {
    path: ['endDate'],
    message: 'The end date must be on or after the start date',
  });
export type EnquirySchedule = z.infer<typeof enquiryScheduleSchema>;

const enquiryBody = {
  categoryId: objectIdSchema,
  lines: z
    .array(enquiryLineSchema)
    .min(1, 'Add at least one skill')
    .max(20)
    .refine((l) => new Set(l.map((x) => x.skillId)).size === l.length, 'Each skill may appear once'),
  schedule: enquiryScheduleSchema,
  description: z.string().trim().min(10, 'Describe the work in a few words').max(2000),
  budgetPaise: paiseSchema.optional(),
};

export const enquiryCreateSchema = z.object({ ...enquiryBody, siteId: objectIdSchema }).strict();
export type EnquiryCreateInput = z.infer<typeof enquiryCreateSchema>;

export const adminEnquiryCreateSchema = enquiryCreateSchema.extend({ companyId: objectIdSchema }).strict();
export type AdminEnquiryCreateInput = z.infer<typeof adminEnquiryCreateSchema>;

export const leadSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    companyName: z.string().trim().min(2).max(150),
    mobile: mobileSchema,
    email: z.string().trim().email().max(200).optional(),
    city: z.string().trim().min(2).max(100),
  })
  .strict();

/** Public lead intake. `website` is a honeypot that real visitors never fill in. */
export const publicEnquirySchema = z
  .object({
    ...enquiryBody,
    lead: leadSchema,
    captchaToken: z.string().max(4000).optional(),
    website: z.string().max(0).optional(),
  })
  .strict();
export type PublicEnquiryInput = z.infer<typeof publicEnquirySchema>;

export const enquiryUpdateSchema = z
  .object({ ...enquiryBody, siteId: objectIdSchema })
  .partial()
  .strict();
export type EnquiryUpdateInput = z.infer<typeof enquiryUpdateSchema>;

export const enquiryAssignSchema = z.object({ userId: objectIdSchema.nullable() }).strict();
export const enquiryNoteSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();

/** Statuses an admin may set by hand; QUOTED / ACCEPTED / EXPIRED follow the quotation. */
export const ENQUIRY_MANUAL_STATUSES = ['IN_REVIEW', 'REJECTED', 'CANCELLED'] as const;
export const enquiryStatusSchema = z
  .object({ status: z.enum(ENQUIRY_MANUAL_STATUSES), reason: z.string().trim().max(500).optional() })
  .strict()
  .refine((v) => v.status === 'IN_REVIEW' || (v.reason?.length ?? 0) >= 3, {
    path: ['reason'],
    message: 'Give a reason',
  });

export const enquiryCancelSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const convertLeadSchema = z
  .object({
    companyId: objectIdSchema.optional(),
    newCompany: companyCreateSchema.optional(),
    site: siteInputSchema.optional(),
  })
  .strict()
  .refine((v) => !!v.companyId !== !!v.newCompany, {
    message: 'Choose an existing company or enter a new one',
    path: ['companyId'],
  });
export type ConvertLeadInput = z.input<typeof convertLeadSchema>;

/**
 * Allowed enquiry transitions (FR-ENQ-02). Revising a quotation moves the enquiry back to IN_REVIEW
 * while the new version is drafted; sending it makes the enquiry QUOTED again.
 */
export const ENQUIRY_TRANSITIONS: Record<EnquiryStatus, readonly EnquiryStatus[]> = {
  NEW: ['IN_REVIEW', 'QUOTED', 'REJECTED', 'CANCELLED'],
  IN_REVIEW: ['QUOTED', 'REJECTED', 'CANCELLED'],
  QUOTED: ['QUOTED', 'IN_REVIEW', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  REJECTED: ['QUOTED', 'IN_REVIEW'],
  EXPIRED: ['QUOTED', 'IN_REVIEW', 'CANCELLED'],
  ACCEPTED: [],
  CANCELLED: [],
};

export function canTransitionEnquiry(from: EnquiryStatus, to: EnquiryStatus): boolean {
  return ENQUIRY_TRANSITIONS[from].includes(to);
}

export interface EnquiryView {
  id: string;
  enquiryNo: string;
  source: EnquirySource;
  companyId?: string;
  companyName?: string;
  lead?: z.infer<typeof leadSchema>;
  categoryId: string;
  categoryName?: string;
  siteId?: string;
  siteName?: string;
  lines: Array<z.infer<typeof enquiryLineSchema> & { skillName?: string }>;
  schedule: EnquirySchedule;
  description: string;
  budgetPaise?: number;
  status: EnquiryStatus;
  statusReason?: string;
  assignedTo?: { id: string; name: string };
  /** Internal notes: admin views only. */
  notes?: Array<{ by: string; byName?: string; at: string; text: string }>;
  latestQuotation?: {
    id: string;
    quotationNo: string;
    version: number;
    status: QuotationStatus;
    totalPaise: number;
  };
  createdAt: string;
  version: number;
}

export const enquiryListQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(ENQUIRY_STATUSES).optional(),
    source: z.enum(ENQUIRY_SOURCES).optional(),
    assignedTo: z.union([z.literal('me'), z.literal('none'), objectIdSchema]).optional(),
    companyId: objectIdSchema.optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();
export type EnquiryListQuery = z.infer<typeof enquiryListQuerySchema>;

export const companyEnquiryListQuerySchema = paginationQuerySchema
  .extend({ status: z.enum(ENQUIRY_STATUSES).optional() })
  .strict();

/* ================================================================ quotations (FR-QUO-01..06) */

export const BILL_UNITS = ['HOUR', 'DAY', 'MONTH', 'FIXED'] as const;
export type BillUnit = (typeof BILL_UNITS)[number];

export const sacCodeSchema = z.string().regex(/^\d{4,8}$/, 'Enter a 4 to 8 digit SAC code');
export const gstRateBpSchema = z.number().int().min(0).max(2800);

export const quotationLineInputSchema = z
  .object({
    skillId: objectIdSchema,
    description: z.string().trim().min(2).max(300),
    headcount: z.number().int().min(1).max(500),
    unit: z.enum(BILL_UNITS),
    ratePaise: paiseSchema.refine((v) => v > 0, 'Enter a rate'),
    /** Billable units per head over the period (e.g. 26 days, 208 hours, 1 for FIXED). */
    quantity: z.number().int().min(1).max(100_000),
    /** Internal provider-facing rate; never shown to the company. */
    payRatePaise: paiseSchema.optional(),
    sacCode: sacCodeSchema.optional(),
    gstRateBp: gstRateBpSchema.optional(),
  })
  .strict();
export type QuotationLineInput = z.infer<typeof quotationLineInputSchema>;

export const MILESTONE_DUE = ['ON_ACCEPT', 'ON_START', 'ON_COMPLETION', 'DATE'] as const;
export type MilestoneDue = (typeof MILESTONE_DUE)[number];

export const paymentTermsSchema = z
  .object({
    advancePct: z.number().int().min(0).max(100),
    milestones: z
      .array(
        z
          .object({
            label: z.string().trim().min(2).max(100),
            pct: z.number().int().min(1).max(100),
            due: z.enum(MILESTONE_DUE),
            dueDate: localDateSchema.optional(),
          })
          .strict()
          .refine((m) => m.due !== 'DATE' || !!m.dueDate, {
            path: ['dueDate'],
            message: 'Enter the due date',
          }),
      )
      .max(12),
  })
  .strict()
  .refine((t) => t.milestones.length === 0 || t.milestones.reduce((a, m) => a + m.pct, 0) === 100, {
    path: ['milestones'],
    message: 'Milestone percentages must add up to 100',
  });
export type PaymentTerms = z.infer<typeof paymentTermsSchema>;

export const quotationScheduleSchema = z
  .object({
    startDate: localDateSchema,
    endDate: localDateSchema,
    weekdays: weekdaysSchema,
    shift: workShiftSchema,
  })
  .strict()
  .refine((s) => s.endDate >= s.startDate, {
    path: ['endDate'],
    message: 'The end date must be on or after the start date',
  });
export type QuotationSchedule = z.infer<typeof quotationScheduleSchema>;

export const quotationInputSchema = z
  .object({
    siteId: objectIdSchema,
    lines: z.array(quotationLineInputSchema).min(1, 'Add at least one line').max(50),
    discountPaise: paiseSchema.default(0),
    schedule: quotationScheduleSchema,
    paymentTerms: paymentTermsSchema,
    terms: z.string().trim().max(5000).default(''),
    validUntil: localDateSchema,
  })
  .strict();
export type QuotationInput = z.input<typeof quotationInputSchema>;

export const quotationRejectSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

export const QUOTATION_TRANSITIONS: Record<QuotationStatus, readonly QuotationStatus[]> = {
  DRAFT: ['SENT'],
  SENT: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
  SUPERSEDED: [],
};

export interface QuotationLineView {
  lineId: string;
  skillId: string;
  skillName?: string;
  description: string;
  headcount: number;
  unit: BillUnit;
  ratePaise: number;
  quantity: number;
  /** Admin views only. */
  payRatePaise?: number;
  sacCode: string;
  gstRateBp: number;
  amountPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
}

export interface QuotationView {
  id: string;
  quotationNo: string;
  version: number;
  isLatest: boolean;
  enquiryId: string;
  enquiryNo?: string;
  companyId: string;
  companyName?: string;
  siteId: string;
  siteName?: string;
  lines: QuotationLineView[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  tax: { type: SupplyType; cgstPaise: number; sgstPaise: number; igstPaise: number; totalTaxPaise: number };
  totalPaise: number;
  placeOfSupply: { stateCode: string; stateName?: string };
  billingAddress?: GstAddress;
  schedule: QuotationSchedule;
  paymentTerms: PaymentTerms;
  terms: string;
  validUntil: string;
  status: QuotationStatus;
  sentAt?: string;
  decision?: { by: string; byName?: string; at: string; reason?: string };
  jobId?: string;
  hasPdf: boolean;
  createdAt: string;
  /** Optimistic-lock counter for edits (send as If-Match). */
  rev: number;
}

/** Defaults and the supply type inputs for the quotation builder's live totals. */
export interface QuotationTaxContext {
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  defaultGstRateBp: number;
  defaultSacCode: string;
  defaultValidUntil: string;
}

export interface QuotationAcceptResult {
  quotation: QuotationView;
  jobId: string;
  jobNo: string;
}

export const quotationListQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(QUOTATION_STATUSES).optional(),
    enquiryId: objectIdSchema.optional(),
    companyId: objectIdSchema.optional(),
  })
  .strict();
