import { z } from 'zod';
import { cursorQuerySchema } from './common';
import { NOTIFICATION_CHANNELS, USER_TYPES, type NotificationChannel } from './enums';

/* ------------------------------------------------------------------ audit logs (FR-AUD-03) */

export const auditQuerySchema = cursorQuerySchema
  .extend({
    entityType: z.string().max(50).optional(),
    entityId: z.string().max(64).optional(),
    actorId: z.string().max(64).optional(),
    action: z.string().max(100).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditLogView {
  id: string;
  at: string;
  actor: { userId?: string; userType?: string; roleCodes?: string[]; system?: string };
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  requestId?: string;
  ip?: string;
  isFinancial: boolean;
}

/* ------------------------------------------------------------------ business config (FR-CFG-01) */

export const updateConfigSchema = z.object({ value: z.unknown() }).strict();

export interface ConfigEntryView {
  key: string;
  group: string;
  description: string;
  value: unknown;
  defaultValue: unknown;
  version: number;
  isDefault: boolean;
  updatedAt?: string;
}

/* ------------------------------------------------------------------ notifications (FR-NTF-*) */

export const NOTIFICATION_AUDIENCES = USER_TYPES;
export const NOTIFICATION_PRIORITIES = ['CRITICAL', 'NORMAL'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const NOTIFICATION_STATUSES = [
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'SKIPPED_PREF',
  'SKIPPED_NO_TEMPLATE',
  'SKIPPED_NO_CONTACT',
  'DEFERRED_QUIET',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

const templateVar = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Extracts `{{variable}}` names from template text. */
export function templateVariables(...texts: Array<string | undefined>): string[] {
  const vars = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').matchAll(templateVar)) if (m[1]) vars.add(m[1]);
  return [...vars];
}

/** Renders `{{variable}}` placeholders; unknown variables render as empty strings. */
export function renderTemplate(text: string, data: Record<string, unknown>): string {
  return text.replace(templateVar, (_, name: string) => {
    const value = name
      .split('.')
      .reduce<unknown>(
        (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
        data,
      );
    return value === undefined || value === null ? '' : String(value);
  });
}

export const notificationTemplateSchema = z
  .object({
    eventType: z
      .string()
      .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/, 'Use aggregate.event, e.g. invitation.sent'),
    channel: z.enum(NOTIFICATION_CHANNELS),
    locale: z.enum(['en', 'hi']).default('en'),
    audience: z.enum(NOTIFICATION_AUDIENCES),
    whatsapp: z
      .object({
        templateName: z.string().min(1).max(512),
        language: z.string().min(2).max(10),
        paramOrder: z.array(z.string().max(100)).max(20),
      })
      .optional(),
    sms: z
      .object({ dltTemplateId: z.string().max(50).optional(), body: z.string().min(1).max(1000) })
      .optional(),
    email: z.object({ subject: z.string().min(1).max(200), html: z.string().min(1).max(50_000) }).optional(),
    inApp: z
      .object({
        title: z.string().min(1).max(120),
        body: z.string().min(1).max(500),
        link: z.string().max(300).optional(),
      })
      .optional(),
    isActive: z.boolean().default(true),
  })
  .strict()
  .superRefine((t, ctx) => {
    const key = ({ WHATSAPP: 'whatsapp', SMS: 'sms', EMAIL: 'email', IN_APP: 'inApp' } as const)[t.channel];
    if (!t[key])
      ctx.addIssue({ code: 'custom', path: [key], message: `Content for ${t.channel} is required` });
  });
export type NotificationTemplateInput = z.infer<typeof notificationTemplateSchema>;

export interface NotificationTemplateView extends NotificationTemplateInput {
  id: string;
  variables: string[];
  version: number;
  updatedAt?: string;
}

export const templatePreviewSchema = z.object({ data: z.record(z.unknown()).default({}) }).strict();

export const inboxQuerySchema = cursorQuerySchema
  .extend({ unread: z.enum(['true', 'false']).optional() })
  .strict();

export interface InboxItem {
  id: string;
  eventType: string;
  title: string;
  body: string;
  link?: string;
  createdAt: string;
  readAt?: string;
}

export const notificationPreferencesSchema = z
  .object({
    channels: z.object({ WHATSAPP: z.boolean(), SMS: z.boolean(), EMAIL: z.boolean() }).strict(),
    mutedEventTypes: z.array(z.string().max(100)).max(100),
  })
  .strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  channels: { WHATSAPP: true, SMS: true, EMAIL: true },
  mutedEventTypes: [],
};

export interface NotificationRequestRecipient {
  userId: string;
}

/** Payload of the `notification.requested` outbox event. */
export interface NotificationRequestPayload {
  eventType: string;
  priority: NotificationPriority;
  recipients: NotificationRequestRecipient[];
  data: Record<string, unknown>;
  /** Optional explicit channel order; defaults to config `notification.channelPriority`. */
  channels?: NotificationChannel[];
}
