import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  renderTemplate,
  templateVariables,
  type NotificationChannel,
  type NotificationTemplateInput,
  type NotificationTemplateView,
  type UserType,
} from '@skillconnect/contracts';
import { AuditService, type AuditActor, type AuditContext } from '../../core/audit/audit.service';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { NOTIFICATION_TEMPLATE_MODEL, type NotificationTemplateDoc } from './schemas';

export interface RenderedMessage {
  title?: string;
  body?: string;
  link?: string;
  subject?: string;
  html?: string;
  whatsapp?: { templateName: string; language: string; params: string[] };
  dltTemplateId?: string;
}

/**
 * Default templates seeded on first start (inserted only when missing, never overwritten).
 * Business modules add their own defaults as they are delivered.
 */
const DEFAULT_TEMPLATES: NotificationTemplateInput[] = (['PROFESSIONAL', 'VENDOR', 'COMPANY'] as const)
  .flatMap((audience): NotificationTemplateInput[] => [
    {
      eventType: 'account.created',
      channel: 'IN_APP',
      locale: 'en',
      audience,
      isActive: true,
      inApp: {
        title: 'Welcome to SkillConnect, {{name}}',
        body:
          audience === 'COMPANY'
            ? 'Add your company details and sites to start raising service enquiries.'
            : 'Complete your profile and documents to get verified and start receiving job invitations.',
        link: audience === 'COMPANY' ? '/company' : '/provider',
      },
    },
    {
      eventType: 'account.created',
      channel: 'SMS',
      locale: 'en',
      audience,
      isActive: true,
      sms: { body: 'Welcome to SkillConnect, {{name}}. Sign in to complete your profile.' },
    },
  ])
  .concat(registrationTemplates(), demandTemplates());

/** Registration lifecycle messages for providers (SRS §4.6), in-app and SMS. */
function registrationTemplates(): NotificationTemplateInput[] {
  const events: Array<[string, string, string, string]> = [
    [
      'registration.payment_received',
      'Registration fee received',
      'We received ₹{{amount}}. Your profile goes to verification once submitted.',
      'SkillConnect: we received your registration fee of Rs {{amount}}. Thank you.',
    ],
    [
      'registration.approved',
      'You are verified',
      'Congratulations {{name}}, your registration is approved. You will now receive matching job invitations.',
      'SkillConnect: {{name}}, your registration is approved. You can now receive job invitations.',
    ],
    [
      'registration.changes_requested',
      'Changes needed on your registration',
      'Our verification team asked for changes: {{reason}}',
      'SkillConnect: please update your registration. Reason: {{reason}}',
    ],
    [
      'registration.rejected',
      'Registration not approved',
      'Your registration was not approved: {{reason}}. Any refund due is processed automatically.',
      'SkillConnect: your registration was not approved. Reason: {{reason}}',
    ],
  ];
  return (['PROFESSIONAL', 'VENDOR'] as const).flatMap((audience) =>
    events.flatMap(([eventType, title, body, sms]): NotificationTemplateInput[] => [
      {
        eventType,
        channel: 'IN_APP',
        locale: 'en',
        audience,
        isActive: true,
        inApp: { title, body, link: '/provider/onboarding' },
      },
      { eventType, channel: 'SMS', locale: 'en', audience, isActive: true, sms: { body: sms } },
    ]),
  );
}

/** Companies, enquiries, quotations and jobs (SRS §5, §6.2). Admin messages are in-app only. */
function demandTemplates(): NotificationTemplateInput[] {
  const list: Array<{
    eventType: string;
    audience: 'COMPANY' | 'ADMIN';
    title: string;
    body: string;
    link: string;
    sms?: string;
  }> = [
    {
      eventType: 'company.activated',
      audience: 'COMPANY',
      title: 'Your company is verified',
      body: '{{company}} is now active. You can accept quotations and start jobs.',
      link: '/company',
      sms: 'SkillConnect: {{company}} is verified. You can now accept quotations and start jobs.',
    },
    {
      eventType: 'company.suspended',
      audience: 'COMPANY',
      title: 'Company account suspended',
      body: 'Your company account was suspended. Reason: {{reason}}',
      link: '/company',
      sms: 'SkillConnect: your company account was suspended. Reason: {{reason}}',
    },
    {
      eventType: 'company.user_invited',
      audience: 'COMPANY',
      title: 'Welcome to the {{company}} team',
      body: 'You were added to {{company}} on SkillConnect.',
      link: '/company',
      sms: 'SkillConnect: you were added to the {{company}} team. Sign in with this mobile number to get started.',
    },
    {
      eventType: 'quotation.sent',
      audience: 'COMPANY',
      title: 'Quotation {{quotationNo}} received',
      body: 'Total ₹{{amount}} including GST, valid until {{validUntil}}. Review and accept it in the portal.',
      link: '/company/quotations/{{id}}',
      sms: 'SkillConnect: quotation {{quotationNo}} for Rs {{amount}} is ready, valid until {{validUntil}}. Review it in your portal.',
    },
    {
      eventType: 'job.created',
      audience: 'COMPANY',
      title: 'Job {{jobNo}} is open',
      body: '{{title}}: we are now finding verified people for it.',
      link: '/company/jobs/{{id}}',
    },
    {
      eventType: 'job.on_hold',
      audience: 'COMPANY',
      title: 'Job {{jobNo}} is on hold',
      body: 'Reason: {{reason}}',
      link: '/company/jobs/{{id}}',
    },
    {
      eventType: 'job.cancelled',
      audience: 'COMPANY',
      title: 'Job {{jobNo}} cancelled',
      body: 'Reason: {{reason}}',
      link: '/company/jobs/{{id}}',
      sms: 'SkillConnect: job {{jobNo}} was cancelled. Reason: {{reason}}',
    },
    {
      eventType: 'enquiry.received',
      audience: 'ADMIN',
      title: 'New enquiry {{enquiryNo}}',
      body: 'A new enquiry arrived (source: {{source}}).',
      link: '/admin/enquiries/{{id}}',
    },
    {
      eventType: 'enquiry.assigned',
      audience: 'ADMIN',
      title: 'Enquiry {{enquiryNo}} assigned to you',
      body: 'Review it and prepare a quotation.',
      link: '/admin/enquiries/{{id}}',
    },
    {
      eventType: 'quotation.accepted',
      audience: 'ADMIN',
      title: 'Quotation {{quotationNo}} accepted',
      body: '{{company}} accepted the quotation. Job {{jobNo}} is open for matching.',
      link: '/admin/jobs/{{jobId}}',
    },
    {
      eventType: 'quotation.rejected',
      audience: 'ADMIN',
      title: 'Quotation {{quotationNo}} rejected',
      body: 'Reason: {{reason}}',
      link: '/admin/enquiries',
    },
  ];
  return list.flatMap((t): NotificationTemplateInput[] => [
    {
      eventType: t.eventType,
      channel: 'IN_APP',
      locale: 'en',
      audience: t.audience,
      isActive: true,
      inApp: { title: t.title, body: t.body, link: t.link },
    },
    ...(t.sms
      ? [
          {
            eventType: t.eventType,
            channel: 'SMS' as const,
            locale: 'en' as const,
            audience: t.audience,
            isActive: true,
            sms: { body: t.sms },
          },
        ]
      : []),
  ]);
}

export function toTemplateView(t: NotificationTemplateDoc): NotificationTemplateView {
  return {
    id: t._id.toHexString(),
    eventType: t.eventType,
    channel: t.channel,
    locale: t.locale,
    audience: t.audience,
    ...(t.whatsapp ? { whatsapp: t.whatsapp } : {}),
    ...(t.sms ? { sms: t.sms } : {}),
    ...(t.email ? { email: t.email } : {}),
    ...(t.inApp ? { inApp: t.inApp } : {}),
    isActive: t.isActive,
    variables: t.variables,
    version: t.version,
    ...(t.updatedAt ? { updatedAt: t.updatedAt.toISOString() } : {}),
  };
}

function variablesOf(t: NotificationTemplateInput): string[] {
  return templateVariables(
    t.sms?.body,
    t.email?.subject,
    t.email?.html,
    t.inApp?.title,
    t.inApp?.body,
    t.inApp?.link,
    ...(t.whatsapp?.paramOrder.map((p) => `{{${p}}}`) ?? []),
  );
}

/** Rendering never interprets HTML from data: values are escaped for the email channel. */
function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

export function renderMessage(
  t: Pick<NotificationTemplateDoc, 'channel' | 'sms' | 'email' | 'inApp' | 'whatsapp'>,
  data: Record<string, unknown>,
): RenderedMessage {
  switch (t.channel) {
    case 'IN_APP':
      return {
        title: renderTemplate(t.inApp?.title ?? '', data),
        body: renderTemplate(t.inApp?.body ?? '', data),
        ...(t.inApp?.link ? { link: renderTemplate(t.inApp.link, data) } : {}),
      };
    case 'SMS':
      return {
        body: renderTemplate(t.sms?.body ?? '', data),
        ...(t.sms?.dltTemplateId ? { dltTemplateId: t.sms.dltTemplateId } : {}),
      };
    case 'EMAIL': {
      const escaped = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, escapeHtml(v)]));
      return {
        subject: renderTemplate(t.email?.subject ?? '', data),
        html: renderTemplate(t.email?.html ?? '', escaped),
      };
    }
    case 'WHATSAPP':
      return {
        whatsapp: {
          templateName: t.whatsapp?.templateName ?? '',
          language: t.whatsapp?.language ?? 'en',
          params: (t.whatsapp?.paramOrder ?? []).map((p) => renderTemplate(`{{${p}}}`, data)),
        },
      };
  }
}

@Injectable()
export class TemplatesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    @InjectModel(NOTIFICATION_TEMPLATE_MODEL) private readonly templates: Model<NotificationTemplateDoc>,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const t of DEFAULT_TEMPLATES) {
      try {
        await this.templates.updateOne(
          { eventType: t.eventType, channel: t.channel, locale: t.locale, audience: t.audience },
          { $setOnInsert: { ...t, variables: variablesOf(t), version: 0 } },
          { upsert: true },
        );
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
    }
    this.logger.log('Default notification templates ensured');
  }

  async find(
    eventType: string,
    channel: NotificationChannel,
    audience: UserType,
    locale = 'en',
  ): Promise<NotificationTemplateDoc | null> {
    return this.templates
      .findOne({ eventType, channel, audience, locale, isActive: true })
      .lean<NotificationTemplateDoc>()
      .exec();
  }

  async list(): Promise<NotificationTemplateView[]> {
    const docs = await this.templates
      .find()
      .sort({ eventType: 1, audience: 1, channel: 1 })
      .lean<NotificationTemplateDoc[]>()
      .exec();
    return docs.map(toTemplateView);
  }

  async get(id: string): Promise<NotificationTemplateDoc> {
    const doc = /^[a-f0-9]{24}$/i.test(id)
      ? await this.templates.findById(id).lean<NotificationTemplateDoc>().exec()
      : null;
    if (!doc) throw new NotFoundError('Notification template', id);
    return doc;
  }

  async create(
    input: NotificationTemplateInput,
    actor: AuditActor,
    ctx?: AuditContext,
  ): Promise<NotificationTemplateView> {
    try {
      const [doc] = await this.templates.create([{ ...input, variables: variablesOf(input), version: 0 }]);
      const created = (doc as unknown as { toObject(): NotificationTemplateDoc }).toObject();
      await this.audit.record({
        actor,
        action: 'template.create',
        entityType: 'NotificationTemplate',
        entityId: created._id.toHexString(),
        after: input,
        context: ctx,
      });
      return toTemplateView(created);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new DomainError(
          'TEMPLATE_DUPLICATE',
          'A template for this event, channel, audience and language already exists.',
        );
      }
      throw err;
    }
  }

  async update(
    id: string,
    input: NotificationTemplateInput,
    expectedVersion: number | undefined,
    actor: AuditActor,
    ctx?: AuditContext,
  ): Promise<NotificationTemplateView> {
    const before = await this.get(id);
    if (expectedVersion !== undefined && expectedVersion !== before.version) {
      throw new DomainError(
        'VERSION_MISMATCH',
        'This template was changed by someone else. Reload and retry.',
      );
    }
    const unset = Object.fromEntries(
      (['whatsapp', 'sms', 'email', 'inApp'] as const).filter((k) => !input[k]).map((k) => [k, 1]),
    );
    try {
      const doc = await this.templates
        .findOneAndUpdate(
          { _id: before._id, version: before.version },
          { $set: { ...input, variables: variablesOf(input) }, $unset: unset, $inc: { version: 1 } },
          { new: true },
        )
        .lean<NotificationTemplateDoc>()
        .exec();
      if (!doc)
        throw new DomainError(
          'VERSION_MISMATCH',
          'This template was changed by someone else. Reload and retry.',
        );
      await this.audit.record({
        actor,
        action: 'template.update',
        entityType: 'NotificationTemplate',
        entityId: id,
        before: toTemplateView(before),
        after: input,
        context: ctx,
      });
      return toTemplateView(doc);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new DomainError(
          'TEMPLATE_DUPLICATE',
          'A template for this event, channel, audience and language already exists.',
        );
      }
      throw err;
    }
  }

  async preview(id: string, data: Record<string, unknown>): Promise<RenderedMessage> {
    return renderMessage(await this.get(id), data);
  }
}
