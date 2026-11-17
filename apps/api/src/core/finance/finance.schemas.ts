import { Schema, type Types } from 'mongoose';
import { LEDGER_BOOKS, type LedgerBook } from '@skillconnect/contracts';

/* ------------------------------------------------------------ webhook_events (DATABASE §3) */

export const WEBHOOK_EVENT_MODEL = 'WebhookEvent';

export interface WebhookEventDoc {
  _id: Types.ObjectId;
  provider: 'RAZORPAY';
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
  domain?: 'REGISTRATION' | 'BUSINESS';
  receivedAt: Date;
  processedAt?: Date;
  error?: string;
  attempts: number;
}

export const webhookEventSchema = new Schema<WebhookEventDoc>(
  {
    provider: { type: String, enum: ['RAZORPAY'], required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'],
      required: true,
      default: 'RECEIVED',
    },
    domain: { type: String, enum: ['REGISTRATION', 'BUSINESS'] },
    receivedAt: { type: Date, required: true, default: () => new Date() },
    processedAt: { type: Date },
    error: { type: String },
    attempts: { type: Number, required: true, default: 0 },
  },
  { collection: 'webhook_events', versionKey: false },
);
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ status: 1, receivedAt: 1 });

/* ------------------------------------------------------------ ledger_entries (append-only) */

export const LEDGER_ACCOUNTS = [
  'GATEWAY_CLEARING',
  'BANK',
  'ACCOUNTS_RECEIVABLE',
  'REGISTRATION_REVENUE',
  'SERVICE_REVENUE',
  'GST_OUTPUT',
  'REFUND_PAYABLE',
  'UNAPPLIED_CASH',
  'WAIVER_EXPENSE',
] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export const LEDGER_MODEL = 'LedgerEntry';

export interface LedgerEntryDoc {
  _id: Types.ObjectId;
  journalId: string;
  book: LedgerBook;
  account: LedgerAccount;
  debitPaise: number;
  creditPaise: number;
  currency: 'INR';
  refType: string;
  refId: string;
  partyType?: string;
  partyId?: string;
  narration: string;
  postedAt: Date;
  postedBy?: string;
  reversesJournalId?: string;
}

export const ledgerEntrySchema = new Schema<LedgerEntryDoc>(
  {
    journalId: { type: String, required: true },
    book: { type: String, enum: LEDGER_BOOKS, required: true },
    account: { type: String, enum: LEDGER_ACCOUNTS, required: true },
    debitPaise: { type: Number, required: true, min: 0 },
    creditPaise: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['INR'], required: true, default: 'INR' },
    refType: { type: String, required: true },
    refId: { type: String, required: true },
    partyType: { type: String },
    partyId: { type: String },
    narration: { type: String, required: true },
    postedAt: { type: Date, required: true, default: () => new Date() },
    postedBy: { type: String },
    reversesJournalId: { type: String },
  },
  { collection: 'ledger_entries', versionKey: false },
);
ledgerEntrySchema.index({ journalId: 1 });
ledgerEntrySchema.index({ book: 1, account: 1, postedAt: 1 });
ledgerEntrySchema.index({ refType: 1, refId: 1 });
ledgerEntrySchema.index({ partyType: 1, partyId: 1, postedAt: 1 });

export const FINANCE_SCHEMAS = [
  { name: WEBHOOK_EVENT_MODEL, schema: webhookEventSchema },
  { name: LEDGER_MODEL, schema: ledgerEntrySchema },
];
