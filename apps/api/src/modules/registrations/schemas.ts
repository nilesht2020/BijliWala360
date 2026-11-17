import { Schema, type Types } from 'mongoose';
import {
  PAYMENT_STATUSES,
  PROVIDER_TYPES,
  REFUND_STATUSES,
  REGISTRATION_PAYMENT_STATES,
  VERIFICATION_STATES,
  type OfflineMethod,
  type PaymentStatus,
  type PlanSnapshot,
  type ProviderType,
  type RefundStatus,
  type RegistrationPaymentState,
  type VerificationState,
} from '@skillconnect/contracts';

/* ------------------------------------------------------------ provider_registrations (DATABASE §7) */

export const REGISTRATION_MODEL = 'ProviderRegistration';

export interface RegistrationDoc {
  _id: Types.ObjectId;
  providerType: ProviderType;
  providerId: Types.ObjectId;
  providerName: string;
  planSnapshot?: PlanSnapshot;
  payment: {
    status: RegistrationPaymentState;
    totalPaise: number;
    paidPaise: number;
    refundedPaise: number;
    waiver?: { by: string; reason: string; at: Date };
  };
  verification: {
    status: VerificationState;
    submittedAt?: Date;
    checklist: Array<{ item: string; result: 'OK' | 'ISSUE' | 'PENDING'; comment?: string }>;
    decisions: Array<{
      decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
      by: string;
      at: Date;
      reason?: string;
      checklistSnapshot?: unknown;
    }>;
    changesRequested?: { comment: string; items: string[] };
  };
  version: number;
  createdAt: Date;
}

export const registrationSchema = new Schema<RegistrationDoc>(
  {
    providerType: { type: String, enum: PROVIDER_TYPES, required: true },
    providerId: { type: Schema.Types.ObjectId, required: true },
    providerName: { type: String, required: true },
    planSnapshot: { type: Schema.Types.Mixed },
    payment: {
      status: { type: String, enum: REGISTRATION_PAYMENT_STATES, default: 'UNPAID' },
      totalPaise: { type: Number, default: 0 },
      paidPaise: { type: Number, default: 0 },
      refundedPaise: { type: Number, default: 0 },
      waiver: { type: new Schema({ by: String, reason: String, at: Date }, { _id: false }) },
    },
    verification: {
      status: { type: String, enum: VERIFICATION_STATES, default: 'NOT_SUBMITTED' },
      submittedAt: Date,
      checklist: {
        type: [new Schema({ item: String, result: String, comment: String }, { _id: false })],
        default: [],
      },
      decisions: {
        type: [
          new Schema(
            { decision: String, by: String, at: Date, reason: String, checklistSnapshot: Schema.Types.Mixed },
            { _id: false },
          ),
        ],
        default: [],
      },
      changesRequested: { type: new Schema({ comment: String, items: [String] }, { _id: false }) },
    },
    version: { type: Number, default: 0 },
  },
  { collection: 'provider_registrations', timestamps: true, versionKey: false },
);
registrationSchema.index({ providerType: 1, providerId: 1 }, { unique: true });
registrationSchema.index({ 'verification.status': 1, 'verification.submittedAt': 1 });
registrationSchema.index({ 'payment.status': 1 });

/* ------------------------------------------------------------ registration_payments */

export const REGISTRATION_PAYMENT_MODEL = 'RegistrationPayment';

export interface RegistrationPaymentDoc {
  _id: Types.ObjectId;
  registrationId: Types.ObjectId;
  providerType: ProviderType;
  providerId: Types.ObjectId;
  providerName: string;
  purpose: 'REGISTRATION';
  mode: 'ONLINE' | 'OFFLINE';
  method?: OfflineMethod | string;
  basePaise: number;
  taxPaise: number;
  amountPaise: number;
  currency: 'INR';
  gateway?: { orderId: string; paymentId?: string; signatureVerifiedAt?: Date; method?: string };
  offline?: {
    reference: string;
    referenceKey: string;
    bank?: string;
    paidOn: string;
    proofDocId: Types.ObjectId;
  };
  status: PaymentStatus;
  capturedPaise: number;
  refundedPaise: number;
  recordedBy: string;
  verifiedBy?: string;
  verifiedAt?: Date;
  rejectionReason?: string;
  failureReason?: string;
  version: number;
  createdAt: Date;
}

export const registrationPaymentSchema = new Schema<RegistrationPaymentDoc>(
  {
    registrationId: { type: Schema.Types.ObjectId, required: true },
    providerType: { type: String, enum: PROVIDER_TYPES, required: true },
    providerId: { type: Schema.Types.ObjectId, required: true },
    providerName: { type: String, required: true },
    purpose: { type: String, enum: ['REGISTRATION'], default: 'REGISTRATION' },
    mode: { type: String, enum: ['ONLINE', 'OFFLINE'], required: true },
    method: String,
    basePaise: { type: Number, required: true },
    taxPaise: { type: Number, required: true },
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    gateway: {
      type: new Schema(
        { orderId: String, paymentId: String, signatureVerifiedAt: Date, method: String },
        { _id: false },
      ),
    },
    offline: {
      type: new Schema(
        {
          reference: String,
          referenceKey: String,
          bank: String,
          paidOn: String,
          proofDocId: Schema.Types.ObjectId,
        },
        { _id: false },
      ),
    },
    status: { type: String, enum: PAYMENT_STATUSES, required: true },
    capturedPaise: { type: Number, default: 0 },
    refundedPaise: { type: Number, default: 0 },
    recordedBy: { type: String, required: true },
    verifiedBy: String,
    verifiedAt: Date,
    rejectionReason: String,
    failureReason: String,
    version: { type: Number, default: 0 },
  },
  { collection: 'registration_payments', timestamps: true, versionKey: false },
);
registrationPaymentSchema.index({ registrationId: 1, createdAt: -1 });
registrationPaymentSchema.index(
  { 'gateway.orderId': 1 },
  { unique: true, partialFilterExpression: { 'gateway.orderId': { $type: 'string' } } },
);
registrationPaymentSchema.index(
  { 'gateway.paymentId': 1 },
  { unique: true, partialFilterExpression: { 'gateway.paymentId': { $type: 'string' } } },
);
// Duplicate offline references are refused (FR-BPAY-07), except for rejected/failed attempts.
registrationPaymentSchema.index(
  { 'offline.referenceKey': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'offline.referenceKey': { $type: 'string' },
      status: { $in: ['PENDING_VERIFICATION', 'SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
    },
  },
);
registrationPaymentSchema.index({ status: 1, mode: 1, createdAt: 1 });

/* ------------------------------------------------------------ registration_refunds */

export const REGISTRATION_REFUND_MODEL = 'RegistrationRefund';

export interface RegistrationRefundDoc {
  _id: Types.ObjectId;
  paymentId: Types.ObjectId;
  registrationId: Types.ObjectId;
  amountPaise: number;
  reason: string;
  mode: 'ONLINE' | 'OFFLINE';
  status: RefundStatus;
  gatewayRefundId?: string;
  offlineReference?: string;
  requestedBy: string;
  approvedBy?: string;
  processedAt?: Date;
  failureReason?: string;
  version: number;
  createdAt: Date;
}

export const registrationRefundSchema = new Schema<RegistrationRefundDoc>(
  {
    paymentId: { type: Schema.Types.ObjectId, required: true },
    registrationId: { type: Schema.Types.ObjectId, required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true },
    mode: { type: String, enum: ['ONLINE', 'OFFLINE'], required: true },
    status: { type: String, enum: REFUND_STATUSES, required: true },
    gatewayRefundId: String,
    offlineReference: String,
    requestedBy: { type: String, required: true },
    approvedBy: String,
    processedAt: Date,
    failureReason: String,
    version: { type: Number, default: 0 },
  },
  { collection: 'registration_refunds', timestamps: true, versionKey: false },
);
registrationRefundSchema.index({ paymentId: 1 });
registrationRefundSchema.index(
  { gatewayRefundId: 1 },
  { unique: true, partialFilterExpression: { gatewayRefundId: { $type: 'string' } } },
);
registrationRefundSchema.index({ status: 1, createdAt: 1 });

export const REGISTRATION_SCHEMAS = [
  { name: REGISTRATION_MODEL, schema: registrationSchema },
  { name: REGISTRATION_PAYMENT_MODEL, schema: registrationPaymentSchema },
  { name: REGISTRATION_REFUND_MODEL, schema: registrationRefundSchema },
];
