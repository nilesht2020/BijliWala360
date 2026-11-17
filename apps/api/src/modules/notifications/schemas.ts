import { Schema, type Types } from 'mongoose';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_STATUSES,
  USER_TYPES,
  type NotificationChannel,
  type NotificationPriority,
  type NotificationStatus,
  type UserType,
} from '@skillconnect/contracts';

/* --------------------------------------------------------- notification_templates (DATABASE §12) */

export const NOTIFICATION_TEMPLATE_MODEL = 'NotificationTemplate';

export interface NotificationTemplateDoc {
  _id: Types.ObjectId;
  eventType: string;
  channel: NotificationChannel;
  locale: 'en' | 'hi';
  audience: UserType;
  whatsapp?: { templateName: string; language: string; paramOrder: string[] };
  sms?: { dltTemplateId?: string; body: string };
  email?: { subject: string; html: string };
  inApp?: { title: string; body: string; link?: string };
  variables: string[];
  isActive: boolean;
  version: number;
  updatedAt: Date;
}

export const notificationTemplateSchema = new Schema<NotificationTemplateDoc>(
  {
    eventType: { type: String, required: true },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    locale: { type: String, enum: ['en', 'hi'], required: true, default: 'en' },
    audience: { type: String, enum: USER_TYPES, required: true },
    whatsapp: {
      type: new Schema({ templateName: String, language: String, paramOrder: [String] }, { _id: false }),
    },
    sms: { type: new Schema({ dltTemplateId: String, body: String }, { _id: false }) },
    email: { type: new Schema({ subject: String, html: String }, { _id: false }) },
    inApp: { type: new Schema({ title: String, body: String, link: String }, { _id: false }) },
    variables: { type: [String], default: [] },
    isActive: { type: Boolean, required: true, default: true },
    version: { type: Number, required: true, default: 0 },
  },
  { collection: 'notification_templates', timestamps: true, versionKey: false },
);
notificationTemplateSchema.index({ eventType: 1, channel: 1, locale: 1, audience: 1 }, { unique: true });

/* --------------------------------------------------------- notifications (delivery log + inbox) */

export const NOTIFICATION_MODEL = 'Notification';

export interface NotificationDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  eventType: string;
  eventId: string;
  channel: NotificationChannel;
  priority: NotificationPriority;
  rendered?: { title?: string; body?: string; link?: string };
  status: NotificationStatus;
  providerMessageId?: string;
  attempts: number;
  lastError?: string;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  createdAt: Date;
}

export const notificationSchema = new Schema<NotificationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    eventType: { type: String, required: true },
    eventId: { type: String, required: true },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    priority: { type: String, enum: NOTIFICATION_PRIORITIES, required: true },
    rendered: { type: new Schema({ title: String, body: String, link: String }, { _id: false }) },
    status: { type: String, enum: NOTIFICATION_STATUSES, required: true },
    providerMessageId: { type: String },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
    readAt: { type: Date },
  },
  { collection: 'notifications', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
// Send idempotency: one record per event, recipient and channel.
notificationSchema.index({ eventId: 1, userId: 1, channel: 1 }, { unique: true });
notificationSchema.index({ userId: 1, channel: 1, readAt: 1, createdAt: -1 });
notificationSchema.index(
  { providerMessageId: 1 },
  { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } } },
);
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

/* --------------------------------------------------------- notification_preferences */

export const NOTIFICATION_PREFERENCE_MODEL = 'NotificationPreference';

export interface NotificationPreferenceDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  channels: { WHATSAPP: boolean; SMS: boolean; EMAIL: boolean };
  mutedEventTypes: string[];
}

export const notificationPreferenceSchema = new Schema<NotificationPreferenceDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    channels: {
      WHATSAPP: { type: Boolean, default: true },
      SMS: { type: Boolean, default: true },
      EMAIL: { type: Boolean, default: true },
    },
    mutedEventTypes: { type: [String], default: [] },
  },
  { collection: 'notification_preferences', timestamps: true, versionKey: false },
);
notificationPreferenceSchema.index({ userId: 1 }, { unique: true });

export const NOTIFICATION_SCHEMAS = [
  { name: NOTIFICATION_TEMPLATE_MODEL, schema: notificationTemplateSchema },
  { name: NOTIFICATION_MODEL, schema: notificationSchema },
  { name: NOTIFICATION_PREFERENCE_MODEL, schema: notificationPreferenceSchema },
];
