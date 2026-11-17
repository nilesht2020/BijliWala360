/**
 * Shared status enums. Kept as `as const` tuples so they can feed both Zod (`z.enum`) and
 * Mongoose (`enum:`) without duplication.
 */
export const USER_TYPES = ['ADMIN', 'COMPANY', 'PROFESSIONAL', 'VENDOR', 'VENDOR_WORKER'] as const;
export type UserType = (typeof USER_TYPES)[number];

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SCOPE_TYPES = ['PLATFORM', 'COMPANY', 'VENDOR'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const PROVIDER_TYPES = ['PROFESSIONAL', 'VENDOR'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PROVIDER_STATUSES = [
  'DRAFT',
  'PENDING_PAYMENT',
  'PENDING_VERIFICATION',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'DEACTIVATED',
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const WORKER_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'REJECTED', 'INACTIVE'] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const DOCUMENT_STATUSES = [
  'PENDING_UPLOAD',
  'SCANNING',
  'UPLOADED',
  'VERIFIED',
  'REJECTED',
  'REJECTED_MALWARE',
  'REJECTED_TYPE',
  'EXPIRED',
  'SUPERSEDED',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const COMPANY_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const ENQUIRY_STATUSES = [
  'NEW',
  'IN_REVIEW',
  'QUOTED',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const QUOTATION_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

export const JOB_STATUSES = [
  'DRAFT',
  'OPEN',
  'MATCHING',
  'ALLOCATING',
  'PARTIALLY_STAFFED',
  'STAFFED',
  'IN_PROGRESS',
  'COMPLETED',
  'ON_HOLD',
  'CANCELLED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const INVITATION_STATUSES = [
  'SENT',
  'VIEWED',
  'RESPONDED_INTERESTED',
  'RESPONDED_DECLINED',
  'EXPIRED',
  'WITHDRAWN',
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const PROPOSAL_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const COMMITMENT_STATUSES = ['HELD', 'CONFIRMED', 'RELEASED'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const ASSIGNMENT_STATUSES = [
  'CONFIRMED',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
  'REPLACED',
  'NO_SHOW',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const INVOICE_STATUSES = [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
  'VOID',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_MODES = ['ONLINE', 'OFFLINE'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const OFFLINE_METHODS = [
  'BANK_TRANSFER',
  'NEFT',
  'RTGS',
  'IMPS',
  'CHEQUE',
  'UPI_DIRECT',
  'CASH',
  'OTHER',
] as const;
export type OfflineMethod = (typeof OFFLINE_METHODS)[number];

export const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING_CONFIRMATION',
  'PENDING_VERIFICATION',
  'SUCCESS',
  'FAILED',
  'REJECTED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const CHEQUE_STATUSES = ['RECEIVED', 'DEPOSITED', 'CLEARED', 'BOUNCED'] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];

export const REFUND_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'REJECTED',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const COMPLAINT_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const COMPLAINT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ComplaintSeverity = (typeof COMPLAINT_SEVERITIES)[number];

export const LEDGER_BOOKS = ['REGISTRATION', 'BUSINESS'] as const;
export type LedgerBook = (typeof LEDGER_BOOKS)[number];

export const NOTIFICATION_CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL', 'IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
