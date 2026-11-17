import { z } from 'zod';
import type { DocumentView } from './catalog';
import type { ProfessionalView, VendorView } from './providers';
import { localDateSchema, objectIdSchema, paginationQuerySchema } from './common';
import {
  OFFLINE_METHODS,
  PAYMENT_STATUSES,
  PROVIDER_TYPES,
  REFUND_STATUSES,
  type OfflineMethod,
  type PaymentStatus,
  type ProviderStatus,
  type ProviderType,
  type RefundStatus,
} from './enums';

/* ================================================================ registration & payments (§4.6, §7) */

export const REGISTRATION_PAYMENT_STATES = [
  'UNPAID',
  'PENDING',
  'PAID',
  'WAIVED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type RegistrationPaymentState = (typeof REGISTRATION_PAYMENT_STATES)[number];

export const VERIFICATION_STATES = [
  'NOT_SUBMITTED',
  'PENDING',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const selectPlanSchema = z.object({ planCode: z.string().max(40) }).strict();

export const checkoutVerifySchema = z
  .object({
    razorpay_order_id: z.string().min(1).max(100),
    razorpay_payment_id: z.string().min(1).max(100),
    razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid signature'),
  })
  .strict();
export type CheckoutVerifyInput = z.infer<typeof checkoutVerifySchema>;

export const offlinePaymentSchema = z
  .object({
    method: z.enum(OFFLINE_METHODS),
    reference: z.string().trim().min(4, 'Enter the UTR, cheque or transaction number').max(40),
    bank: z.string().trim().max(80).optional(),
    paidOn: localDateSchema,
    proofDocId: objectIdSchema,
  })
  .strict();
export type OfflinePaymentInput = z.infer<typeof offlinePaymentSchema>;

export const checklistItemSchema = z
  .object({
    item: z.string().max(80),
    result: z.enum(['OK', 'ISSUE', 'PENDING']),
    comment: z.string().trim().max(500).optional(),
  })
  .strict();
export const checklistSchema = z.object({ items: z.array(checklistItemSchema).max(50) }).strict();
export type ChecklistInput = z.infer<typeof checklistSchema>;

export const decisionReasonSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
export const requestChangesSchema = z
  .object({
    comment: z.string().trim().min(3).max(1000),
    items: z.array(z.string().max(80)).max(30).default([]),
  })
  .strict();

export const paymentDecisionSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const offlineRefundCompleteSchema = z
  .object({ reference: z.string().trim().min(4).max(40), note: z.string().trim().max(500).optional() })
  .strict();

export const registrationListQuerySchema = paginationQuerySchema
  .extend({
    verificationStatus: z.enum(VERIFICATION_STATES).optional(),
    providerType: z.enum(PROVIDER_TYPES).optional(),
    paymentStatus: z.enum(REGISTRATION_PAYMENT_STATES).optional(),
  })
  .strict();

export const registrationPaymentListQuerySchema = paginationQuerySchema
  .extend({ status: z.enum(PAYMENT_STATUSES).optional(), mode: z.enum(['ONLINE', 'OFFLINE']).optional() })
  .strict();

export interface PlanSnapshot {
  planId: string;
  code: string;
  name: string;
  feePaise: number;
  gstRateBp: number;
  taxPaise: number;
  totalPaise: number;
  maxWorkers: number | null;
  mandatoryDocTypeCodes: string[];
  offlinePaymentAllowed: boolean;
  gstinRequired: boolean;
  refundPolicy: { onRejection: 'FULL' | 'PARTIAL' | 'NONE'; partialPct?: number };
}

export interface ChecklistItemView {
  item: string;
  result: 'OK' | 'ISSUE' | 'PENDING';
  comment?: string;
}

export interface VerificationDecisionView {
  decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  by: string;
  at: string;
  reason?: string;
}

export interface RegistrationView {
  id: string;
  providerType: ProviderType;
  providerId: string;
  providerName: string;
  providerStatus: ProviderStatus;
  plan?: PlanSnapshot;
  payment: {
    status: RegistrationPaymentState;
    totalPaise: number;
    paidPaise: number;
    refundedPaise: number;
    waiver?: { reason: string; at: string };
  };
  verification: {
    status: VerificationState;
    submittedAt?: string;
    checklist: ChecklistItemView[];
    decisions: VerificationDecisionView[];
    changesRequested?: { comment: string; items: string[] };
  };
  createdAt: string;
}

export interface RegistrationPaymentView {
  id: string;
  registrationId: string;
  providerType: ProviderType;
  providerName?: string;
  mode: 'ONLINE' | 'OFFLINE';
  method?: OfflineMethod | string;
  basePaise: number;
  taxPaise: number;
  amountPaise: number;
  status: PaymentStatus;
  capturedPaise: number;
  refundedPaise: number;
  gateway?: { orderId: string; paymentId?: string };
  offline?: { reference: string; bank?: string; paidOn: string; proofDocId: string };
  rejectionReason?: string;
  failureReason?: string;
  createdAt: string;
}

export interface OnlineOrderResponse {
  paymentId: string;
  mode: 'live' | 'fake';
  razorpay: {
    keyId: string;
    orderId: string;
    amount: number;
    currency: 'INR';
    name: string;
    description: string;
  };
}

export interface RegistrationRefundView {
  id: string;
  paymentId: string;
  registrationId: string;
  amountPaise: number;
  reason: string;
  mode: 'ONLINE' | 'OFFLINE';
  status: RefundStatus;
  gatewayRefundId?: string;
  offlineReference?: string;
  createdAt: string;
}

export const refundListQuerySchema = paginationQuerySchema
  .extend({ status: z.enum(REFUND_STATUSES).optional() })
  .strict();

export interface ReadinessView {
  planSelected: boolean;
  missingProfile: string[];
  missingDocuments: Array<{ code: string; name: string }>;
  requiredDocuments: Array<{ code: string; name: string }>;
  canSubmit: boolean;
}

/** Everything a verification officer needs on one screen. */
export interface RegistrationDetailView {
  registration: RegistrationView;
  provider: ProfessionalView | VendorView;
  documents: DocumentView[];
  requiredDocTypeCodes: string[];
  payments: RegistrationPaymentView[];
  refunds: RegistrationRefundView[];
}
