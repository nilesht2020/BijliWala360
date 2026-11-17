import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Mongoose schemas owned by the core layer (DATABASE §3). Indexes are declared here so that the
 * migration runner and test setup can create them via `Model.createIndexes()`; production runs
 * with autoIndex disabled.
 */

export const COUNTER_MODEL = 'Counter';
export const counterSchema = new Schema(
  { _id: { type: String, required: true }, seq: { type: Number, required: true, default: 0 } },
  { collection: 'counters', versionKey: false },
);

export const IDEMPOTENCY_MODEL = 'IdempotencyKey';
export const idempotencySchema = new Schema(
  {
    key: { type: String, required: true },
    userId: { type: String, required: true },
    route: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['IN_PROGRESS', 'COMPLETED'], required: true },
    responseBody: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'idempotency_keys', timestamps: true, versionKey: false },
);
idempotencySchema.index({ key: 1, userId: 1, route: 1 }, { unique: true });
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export type IdempotencyDoc = InferSchemaType<typeof idempotencySchema>;

export const OUTBOX_MODEL = 'OutboxEvent';
export const outboxSchema = new Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    aggregateType: { type: String, required: true },
    aggregateId: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['PENDING', 'DISPATCHED', 'FAILED'], required: true, default: 'PENDING' },
    attempts: { type: Number, required: true, default: 0 },
    leaseUntil: { type: Date },
    dispatchedAt: { type: Date },
    lastError: { type: String },
  },
  { collection: 'outbox_events', timestamps: true, versionKey: false },
);
outboxSchema.index({ eventId: 1 }, { unique: true });
outboxSchema.index({ status: 1, leaseUntil: 1, createdAt: 1 });
outboxSchema.index({ dispatchedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
export type OutboxDoc = InferSchemaType<typeof outboxSchema>;

export const PROCESSED_EVENT_MODEL = 'ProcessedEvent';
export const processedEventSchema = new Schema(
  {
    consumer: { type: String, required: true },
    eventId: { type: String, required: true },
    processedAt: { type: Date, required: true, default: () => new Date() },
  },
  { collection: 'processed_events', versionKey: false },
);
processedEventSchema.index({ consumer: 1, eventId: 1 }, { unique: true });
processedEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const AUDIT_MODEL = 'AuditLog';
export const auditSchema = new Schema(
  {
    at: { type: Date, required: true, default: () => new Date() },
    actor: {
      userId: { type: String },
      userType: { type: String },
      roleCodes: { type: [String], default: undefined },
      system: { type: String },
    },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    reason: { type: String },
    requestId: { type: String },
    ip: { type: String },
    userAgent: { type: String },
    isFinancial: { type: Boolean, required: true, default: false },
    expireAt: { type: Date },
  },
  { collection: 'audit_logs', versionKey: false },
);
auditSchema.index({ entityType: 1, entityId: 1, at: -1 });
auditSchema.index({ 'actor.userId': 1, at: -1 });
auditSchema.index({ action: 1, at: -1 });
auditSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
export type AuditDoc = InferSchemaType<typeof auditSchema>;

export const BUSINESS_SETTING_MODEL = 'BusinessSetting';
export const businessSettingSchema = new Schema(
  {
    key: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    version: { type: Number, required: true, default: 1 },
    updatedBy: { type: String, required: true },
    history: {
      type: [
        new Schema(
          { value: Schema.Types.Mixed, version: Number, updatedBy: String, updatedAt: Date },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { collection: 'business_settings', timestamps: true, versionKey: false },
);
businessSettingSchema.index({ key: 1 }, { unique: true });
export type BusinessSettingDoc = InferSchemaType<typeof businessSettingSchema>;

export const CORE_SCHEMAS = [
  { name: COUNTER_MODEL, schema: counterSchema },
  { name: IDEMPOTENCY_MODEL, schema: idempotencySchema },
  { name: OUTBOX_MODEL, schema: outboxSchema },
  { name: PROCESSED_EVENT_MODEL, schema: processedEventSchema },
  { name: AUDIT_MODEL, schema: auditSchema },
  { name: BUSINESS_SETTING_MODEL, schema: businessSettingSchema },
] as const;
