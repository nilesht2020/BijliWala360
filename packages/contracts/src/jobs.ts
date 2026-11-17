import { z } from 'zod';
import { localDateSchema, objectIdSchema, paginationQuerySchema, paiseSchema, type Shift } from './common';
import { BILL_UNITS, weekdaysSchema, workShiftSchema, type BillUnit } from './demand';
import { JOB_STATUSES, type JobStatus } from './enums';

/* ================================================================ state machine (FR-JOB-03) */

/**
 * Allowed job transitions. ON_HOLD resumes to the status it was put on hold from (checked by the
 * service against the status history), so its list holds every status it may return to.
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  DRAFT: ['OPEN', 'CANCELLED'],
  OPEN: ['MATCHING', 'ON_HOLD', 'CANCELLED'],
  MATCHING: ['OPEN', 'ALLOCATING', 'ON_HOLD', 'CANCELLED'],
  ALLOCATING: ['MATCHING', 'PARTIALLY_STAFFED', 'STAFFED', 'ON_HOLD', 'CANCELLED'],
  PARTIALLY_STAFFED: ['ALLOCATING', 'STAFFED', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD', 'CANCELLED'],
  STAFFED: ['PARTIALLY_STAFFED', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['PARTIALLY_STAFFED', 'COMPLETED', 'ON_HOLD', 'CANCELLED'],
  ON_HOLD: ['OPEN', 'MATCHING', 'ALLOCATING', 'PARTIALLY_STAFFED', 'STAFFED', 'IN_PROGRESS', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** Statuses in which the job is still live (editable, can be put on hold or cancelled). */
export const LIVE_JOB_STATUSES: readonly JobStatus[] = JOB_STATUSES.filter(
  (s) => s !== 'COMPLETED' && s !== 'CANCELLED',
);

/* ================================================================ inputs */

export const BILLING_BASES = ['MILESTONE', 'ATTENDANCE'] as const;
export type BillingBasis = (typeof BILLING_BASES)[number];

export const jobScheduleSchema = z
  .object({
    startDate: localDateSchema,
    endDate: localDateSchema,
    weekdays: weekdaysSchema,
    excludedDates: z.array(localDateSchema).max(366).default([]),
    timezone: z.string().max(50).default('Asia/Kolkata'),
  })
  .strict()
  .refine((s) => s.endDate >= s.startDate, {
    path: ['endDate'],
    message: 'The end date must be on or after the start date',
  });
export type JobSchedule = z.infer<typeof jobScheduleSchema>;

export const jobPositionInputSchema = z
  .object({
    /** Present when editing an existing position. */
    id: objectIdSchema.optional(),
    skillId: objectIdSchema,
    title: z.string().trim().min(2).max(120),
    minExperienceYears: z.number().int().min(0).max(40).default(0),
    requiredCertDocTypeCodes: z.array(z.string().max(40)).max(10).default([]),
    shift: workShiftSchema,
    required: z.number().int().min(1).max(1000),
    billRatePaise: paiseSchema,
    billUnit: z.enum(BILL_UNITS),
    payRatePaise: paiseSchema.optional(),
    showPayRate: z.boolean().default(false),
    allowPartialAvailability: z.boolean().default(false),
  })
  .strict();
export type JobPositionInput = z.input<typeof jobPositionInputSchema>;

const positionsSchema = z.array(jobPositionInputSchema).min(1, 'Add at least one position').max(30);

export const jobCreateSchema = z
  .object({
    companyId: objectIdSchema,
    siteId: objectIdSchema,
    categoryId: objectIdSchema,
    title: z.string().trim().min(3).max(150),
    description: z.string().trim().max(5000).optional(),
    instructions: z.string().trim().max(5000).optional(),
    schedule: jobScheduleSchema,
    positions: positionsSchema,
    billingBasis: z.enum(BILLING_BASES).default('ATTENDANCE'),
  })
  .strict();
export type JobCreateInput = z.input<typeof jobCreateSchema>;

export const jobUpdateSchema = z
  .object({
    title: z.string().trim().min(3).max(150),
    description: z.string().trim().max(5000),
    instructions: z.string().trim().max(5000),
    schedule: jobScheduleSchema,
    positions: positionsSchema,
  })
  .partial()
  .strict();
export type JobUpdateInput = z.input<typeof jobUpdateSchema>;

export const jobReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const jobListQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(JOB_STATUSES).optional(),
    companyId: objectIdSchema.optional(),
    categoryId: objectIdSchema.optional(),
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const companyJobListQuerySchema = paginationQuerySchema
  .extend({ status: z.enum(JOB_STATUSES).optional() })
  .strict();

/* ================================================================ views */

export interface JobPositionView {
  id: string;
  skillId: string;
  skillName?: string;
  title: string;
  minExperienceYears: number;
  requiredCertDocTypeCodes: string[];
  shift: Shift;
  required: number;
  /** Places reserved by pending allocation proposals (FR-JOB-04 "proposed"). */
  held: number;
  confirmed: number;
  available: number;
  billRatePaise: number;
  billUnit: BillUnit;
  /** Admin views only. */
  payRatePaise?: number;
  showPayRate: boolean;
  allowPartialAvailability: boolean;
}

export interface JobView {
  id: string;
  jobNo: string;
  companyId: string;
  companyName?: string;
  siteId: string;
  siteName?: string;
  siteCity?: string;
  categoryId: string;
  categoryName?: string;
  quotationId?: string;
  quotationNo?: string;
  title: string;
  description?: string;
  instructions?: string;
  schedule: JobSchedule;
  positions: JobPositionView[];
  billingBasis: BillingBasis;
  status: JobStatus;
  /** Admin views only. */
  statusHistory?: Array<{ from: string; to: string; at: string; by?: string; reason?: string }>;
  cancellation?: { at: string; reason: string };
  totals: { required: number; held: number; confirmed: number };
  createdAt: string;
  version: number;
}

/** Consequences of an edit for existing allocations (FR-JOB-05). */
export interface JobImpact {
  positionId: string;
  kind: 'SCHEDULE_CHANGED' | 'SHIFT_CHANGED' | 'HEADCOUNT_REDUCED';
  affected: number;
  message: string;
}

export interface JobUpdateResult {
  job: JobView;
  impact: JobImpact[];
}
