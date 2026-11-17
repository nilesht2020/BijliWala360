import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Logger,
  Module,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Schema, Types, type ClientSession, type FilterQuery, type Model } from 'mongoose';
import { z } from 'zod';
import {
  computeTaxTotals,
  objectIdSchema,
  QUOTATION_STATUSES,
  quotationInputSchema,
  quotationLineInputSchema,
  quotationListQuerySchema,
  quotationRejectSchema,
  stateNameOf,
  TaxInputError,
  type BillUnit,
  type GstAddress,
  type PageMeta,
  type PaymentTerms,
  type QuotationAcceptResult,
  type QuotationSchedule,
  type QuotationStatus,
  type QuotationTaxContext,
  type QuotationView,
  type SupplyType,
  type TaxTotals,
} from '@skillconnect/contracts';
import { actorFromUser, AuditService, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, PlatformOnly, RequirePermissions } from '../../core/auth/decorators';
import { BusinessConfigService } from '../../core/business-config/business-config.service';
import { addDays, findPage, todayIn } from '../../core/database/query';
import { SequenceService } from '../../core/database/sequence.service';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { parseIfMatch } from '../../core/http/if-match';
import { ReqContext } from '../../core/http/request-context';
import { PagedResult } from '../../core/http/response-envelope.interceptor';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';
import { Idempotent, IdempotencyInterceptor } from '../../core/idempotency/idempotency.interceptor';
import { DomainEventBus } from '../../core/outbox/event-bus';
import { OutboxService } from '../../core/outbox/outbox.service';
import { StorageService } from '../../core/storage/storage.service';
import { CatalogModule, CatalogService } from '../catalog/catalog.module';
import {
  CompaniesModule,
  CompaniesService,
  requireCompanyScope,
  siteFilterOf,
} from '../companies/companies.module';
import { EnquiriesModule, EnquiriesService, type EnquiryDoc } from '../enquiries/enquiries.module';
import { JobsModule, JobsService } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationsService } from '../notifications/notifications.service';
import { RolesService } from '../users/roles.service';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';
import { renderQuotationPdf } from './quotation-pdf';

/* ================================================================ schema (DATABASE §8) */

export const QUOTATION_MODEL = 'Quotation';

export interface QuotationLineDoc {
  lineId: string;
  skillId: Types.ObjectId;
  description: string;
  headcount: number;
  unit: BillUnit;
  ratePaise: number;
  quantity: number;
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

export interface QuotationDoc {
  _id: Types.ObjectId;
  quotationNo: string;
  version: number;
  isLatest: boolean;
  enquiryId: Types.ObjectId;
  companyId: Types.ObjectId;
  siteId: Types.ObjectId;
  lines: QuotationLineDoc[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  tax: { type: SupplyType; cgstPaise: number; sgstPaise: number; igstPaise: number; totalTaxPaise: number };
  totalPaise: number;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  billingAddress: GstAddress;
  schedule: QuotationSchedule;
  paymentTerms: PaymentTerms;
  terms: string;
  validUntil: string;
  status: QuotationStatus;
  sentAt?: Date;
  decision?: { by: Types.ObjectId; at: Date; ip?: string; userAgent?: string; reason?: string };
  supersedesId?: Types.ObjectId;
  jobId?: Types.ObjectId;
  pdf?: { key: string; rev: number; generatedAt: Date };
  createdBy: Types.ObjectId;
  rev: number;
  createdAt: Date;
}

const lineSchema = new Schema<QuotationLineDoc>(
  {
    lineId: String,
    skillId: Schema.Types.ObjectId,
    description: String,
    headcount: Number,
    unit: String,
    ratePaise: Number,
    quantity: Number,
    payRatePaise: Number,
    sacCode: String,
    gstRateBp: Number,
    amountPaise: Number,
    discountPaise: Number,
    taxablePaise: Number,
    cgstPaise: Number,
    sgstPaise: Number,
    igstPaise: Number,
    taxPaise: Number,
  },
  { _id: false },
);

const quotationSchema = new Schema<QuotationDoc>(
  {
    quotationNo: { type: String, required: true },
    version: { type: Number, required: true },
    isLatest: { type: Boolean, required: true },
    enquiryId: { type: Schema.Types.ObjectId, required: true },
    companyId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, required: true },
    lines: { type: [lineSchema], required: true },
    subtotalPaise: { type: Number, required: true },
    discountPaise: { type: Number, required: true },
    taxablePaise: { type: Number, required: true },
    tax: { type: Schema.Types.Mixed, required: true },
    totalPaise: { type: Number, required: true },
    supplierStateCode: { type: String, required: true },
    placeOfSupplyStateCode: { type: String, required: true },
    billingAddress: { type: Schema.Types.Mixed, required: true },
    schedule: { type: Schema.Types.Mixed, required: true },
    paymentTerms: { type: Schema.Types.Mixed, required: true },
    terms: { type: String, default: '' },
    validUntil: { type: String, required: true },
    status: { type: String, enum: QUOTATION_STATUSES, required: true },
    sentAt: Date,
    decision: {
      type: new Schema(
        { by: Schema.Types.ObjectId, at: Date, ip: String, userAgent: String, reason: String },
        { _id: false },
      ),
    },
    supersedesId: Schema.Types.ObjectId,
    jobId: Schema.Types.ObjectId,
    pdf: { type: new Schema({ key: String, rev: Number, generatedAt: Date }, { _id: false }) },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    rev: { type: Number, default: 0 },
  },
  { collection: 'quotations', timestamps: true, versionKey: false },
);
quotationSchema.index({ quotationNo: 1, version: 1 }, { unique: true });
quotationSchema.index({ enquiryId: 1, version: -1 });
// Exactly one current version per enquiry: revisions flip the old one and insert the new one atomically.
quotationSchema.index(
  { enquiryId: 1 },
  { unique: true, partialFilterExpression: { isLatest: true }, name: 'one_latest_per_enquiry' },
);
quotationSchema.index({ companyId: 1, status: 1 });
quotationSchema.index({ status: 1, validUntil: 1 });

const QUOTABLE_ENQUIRY: EnquiryDoc['status'][] = ['NEW', 'IN_REVIEW'];

type QuotationInput = z.infer<typeof quotationInputSchema>;

/* ================================================================ service */

@Injectable()
export class QuotationsService implements OnModuleInit {
  private readonly logger = new Logger(QuotationsService.name);

  constructor(
    @InjectModel(QUOTATION_MODEL) private readonly quotations: Model<QuotationDoc>,
    private readonly enquiries: EnquiriesService,
    private readonly companies: CompaniesService,
    private readonly jobs: JobsService,
    private readonly catalog: CatalogService,
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
    private readonly bus: DomainEventBus,
    private readonly storage: StorageService,
    private readonly sequences: SequenceService,
    private readonly config: BusinessConfigService,
    private readonly txn: TransactionRunner,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    // T-12: the PDF is rendered in the background after sending; pdf-url also renders on demand.
    this.bus.subscribe('quotation.sent', 'quotations.pdf', async (event) => {
      const id = (event.payload as { quotationId: string }).quotationId;
      await this.ensurePdf(await this.getDoc(id));
    });
  }

  /* ---------------------------------------------------------------- views */

  async toViews(docs: QuotationDoc[], opts: { admin: boolean }): Promise<QuotationView[]> {
    if (docs.length === 0) return [];
    const { skills } = await this.catalog.nameLookups();
    const names = await this.companies.namesByIds(docs.map((d) => d.companyId));
    const sites = await this.companies.sitesByIds(docs.map((d) => d.siteId));
    const enquiryNos = new Map<string, string>();
    for (const id of new Set(docs.map((d) => d.enquiryId.toHexString())))
      enquiryNos.set(id, (await this.enquiries.getDoc(id)).enquiryNo);
    const deciders = new Map(
      (
        await this.users.findByIds(docs.flatMap((d) => (d.decision ? [d.decision.by.toHexString()] : [])))
      ).map((u) => [u._id.toHexString(), u.name]),
    );
    return docs.map((d) => ({
      id: d._id.toHexString(),
      quotationNo: d.quotationNo,
      version: d.version,
      isLatest: d.isLatest,
      enquiryId: d.enquiryId.toHexString(),
      enquiryNo: enquiryNos.get(d.enquiryId.toHexString()) ?? '',
      companyId: d.companyId.toHexString(),
      companyName: names.get(d.companyId.toHexString()) ?? '',
      siteId: d.siteId.toHexString(),
      siteName: sites.get(d.siteId.toHexString())?.name ?? '',
      lines: d.lines.map(({ skillId, payRatePaise, ...l }) => ({
        ...l,
        skillId: skillId.toHexString(),
        skillName: skills.get(skillId.toHexString())?.name ?? '',
        ...(opts.admin && payRatePaise !== undefined ? { payRatePaise } : {}),
      })),
      subtotalPaise: d.subtotalPaise,
      discountPaise: d.discountPaise,
      taxablePaise: d.taxablePaise,
      tax: d.tax,
      totalPaise: d.totalPaise,
      placeOfSupply: {
        stateCode: d.placeOfSupplyStateCode,
        stateName: stateNameOf(d.placeOfSupplyStateCode) ?? '',
      },
      billingAddress: d.billingAddress,
      schedule: d.schedule,
      paymentTerms: d.paymentTerms,
      terms: d.terms,
      validUntil: d.validUntil,
      status: d.status,
      ...(d.sentAt ? { sentAt: d.sentAt.toISOString() } : {}),
      ...(d.decision
        ? {
            decision: {
              by: d.decision.by.toHexString(),
              byName: deciders.get(d.decision.by.toHexString()) ?? '',
              at: d.decision.at.toISOString(),
              ...(d.decision.reason ? { reason: d.decision.reason } : {}),
            },
          }
        : {}),
      ...(d.jobId ? { jobId: d.jobId.toHexString() } : {}),
      hasPdf: !!d.pdf && d.pdf.rev === d.rev,
      createdAt: d.createdAt.toISOString(),
      rev: d.rev,
    }));
  }

  async toView(doc: QuotationDoc, admin: boolean): Promise<QuotationView> {
    const [view] = await this.toViews([doc], { admin });
    return view as QuotationView;
  }

  async getDoc(id: string | Types.ObjectId, session?: ClientSession): Promise<QuotationDoc> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.quotations.findById(id, undefined, { session }).lean<QuotationDoc>().exec()
      : null;
    if (!doc) throw new NotFoundError('Quotation', String(id));
    return doc;
  }

  private summaryOf(
    q: Pick<QuotationDoc, '_id' | 'quotationNo' | 'version' | 'status' | 'totalPaise'>,
  ): NonNullable<EnquiryDoc['latestQuotation']> {
    return {
      id: q._id,
      quotationNo: q.quotationNo,
      version: q.version,
      status: q.status,
      totalPaise: q.totalPaise,
    };
  }

  /* ---------------------------------------------------------------- pricing (FR-QUO-01/06) */

  /**
   * Fills SAC / GST defaults from the skill and configuration, and computes all amounts with the
   * shared tax engine. Place of supply = the company's billing state (B2B supply of services).
   */
  async price(
    companyBillingState: string,
    input: Pick<QuotationInput, 'lines' | 'discountPaise'>,
  ): Promise<{ lines: QuotationLineDoc[]; totals: TaxTotals; supplierStateCode: string }> {
    const skills = await this.catalog.assertActiveSkills(input.lines.map((l) => l.skillId));
    const bySkill = new Map(skills.map((s) => [s.id, s]));
    const [supplier, defaultRate, defaultSac] = await Promise.all([
      this.config.get('tax.supplier'),
      this.config.get('tax.defaultGstRateBp'),
      this.config.get('tax.defaultSacCode'),
    ]);
    const resolved = input.lines.map((l) => ({
      ...l,
      sacCode: l.sacCode ?? bySkill.get(l.skillId)?.sacCode ?? defaultSac,
      gstRateBp: l.gstRateBp ?? defaultRate,
    }));
    let totals: TaxTotals;
    try {
      totals = computeTaxTotals({
        lines: resolved,
        discountPaise: input.discountPaise,
        supplierStateCode: supplier.stateCode,
        placeOfSupplyStateCode: companyBillingState,
      });
    } catch (err) {
      if (err instanceof TaxInputError)
        throw new DomainError(
          err.field === 'discountPaise' ? 'DISCOUNT_EXCEEDS_SUBTOTAL' : 'VALIDATION_FAILED',
          err.message,
          [{ path: err.field, message: err.message }],
        );
      throw err;
    }
    const lines = resolved.map((l, i): QuotationLineDoc => {
      const t = totals.lines[i] as TaxTotals['lines'][number];
      return {
        lineId: new Types.ObjectId().toHexString(),
        skillId: new Types.ObjectId(l.skillId),
        description: l.description,
        headcount: l.headcount,
        unit: l.unit,
        ratePaise: l.ratePaise,
        quantity: l.quantity,
        ...(l.payRatePaise !== undefined ? { payRatePaise: l.payRatePaise } : {}),
        sacCode: l.sacCode,
        gstRateBp: l.gstRateBp,
        ...t,
      };
    });
    return { lines, totals, supplierStateCode: supplier.stateCode };
  }

  private pricedFields(p: Awaited<ReturnType<QuotationsService['price']>>) {
    return {
      lines: p.lines,
      subtotalPaise: p.totals.subtotalPaise,
      discountPaise: p.totals.discountPaise,
      taxablePaise: p.totals.taxablePaise,
      tax: {
        type: p.totals.type,
        cgstPaise: p.totals.cgstPaise,
        sgstPaise: p.totals.sgstPaise,
        igstPaise: p.totals.igstPaise,
        totalTaxPaise: p.totals.totalTaxPaise,
      },
      totalPaise: p.totals.totalPaise,
      supplierStateCode: p.supplierStateCode,
    };
  }

  async taxContext(companyId: string): Promise<QuotationTaxContext> {
    const company = await this.companies.getById(companyId);
    const [supplier, rate, sac, days] = await Promise.all([
      this.config.get('tax.supplier'),
      this.config.get('tax.defaultGstRateBp'),
      this.config.get('tax.defaultSacCode'),
      this.config.get('quotation.defaultValidityDays'),
    ]);
    return {
      supplierStateCode: supplier.stateCode,
      placeOfSupplyStateCode: company.billingAddress.stateCode,
      defaultGstRateBp: rate,
      defaultSacCode: sac,
      defaultValidUntil: addDays(todayIn(), days),
    };
  }

  async previewTotals(
    id: string,
    input: Pick<QuotationInput, 'lines' | 'discountPaise'>,
  ): Promise<TaxTotals> {
    const q = await this.getDoc(id);
    const company = await this.companies.getById(q.companyId);
    return (await this.price(company.billingAddress.stateCode, input)).totals;
  }

  /* ---------------------------------------------------------------- admin lifecycle */

  async createFromEnquiry(
    enquiryId: string,
    input: QuotationInput,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<QuotationDoc> {
    const enquiry = await this.enquiries.getDoc(enquiryId);
    if (!enquiry.companyId)
      throw new DomainError('LEAD_NOT_CONVERTED', 'Convert this lead into a company before quoting.');
    if (!QUOTABLE_ENQUIRY.includes(enquiry.status))
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        enquiry.latestQuotation
          ? 'This enquiry already has a quotation. Revise it to create a new version.'
          : `A ${enquiry.status.toLowerCase()} enquiry cannot be quoted.`,
      );
    if (await this.quotations.exists({ enquiryId: enquiry._id, isLatest: true }))
      throw new DomainError(
        'STATE_CONFLICT',
        'This enquiry already has a quotation. Revise it to create a new version.',
      );
    const company = await this.companies.requireNotSuspended(enquiry.companyId);
    await this.companies.requireActiveSite(company._id, input.siteId);
    this.assertValidity(input.validUntil);
    const priced = await this.price(company.billingAddress.stateCode, input);
    const prefix = await this.config.get('quotation.prefix');
    const actor = actorFromUser(user);
    try {
      return await this.txn.run(async (session) => {
        const quotationNo = await this.sequences.formatted('quotation', prefix, 6, session);
        const [doc] = await this.quotations.create(
          [
            {
              quotationNo,
              version: 1,
              isLatest: true,
              enquiryId: enquiry._id,
              companyId: company._id,
              siteId: new Types.ObjectId(input.siteId),
              ...this.pricedFields(priced),
              placeOfSupplyStateCode: company.billingAddress.stateCode,
              billingAddress: company.billingAddress,
              schedule: input.schedule,
              paymentTerms: input.paymentTerms,
              terms: input.terms,
              validUntil: input.validUntil,
              status: 'DRAFT',
              createdBy: new Types.ObjectId(user.id),
              rev: 0,
            },
          ],
          { session },
        );
        const q = (doc as unknown as { toObject(): QuotationDoc }).toObject();
        if (enquiry.status === 'NEW')
          await this.enquiries.transition(enquiry._id, 'IN_REVIEW', session, this.summaryOf(q));
        else await this.enquiries.setLatestQuotation(enquiry._id, this.summaryOf(q), session);
        await this.audit.record(
          {
            actor,
            action: 'quotation.create',
            entityType: 'Quotation',
            entityId: q._id.toHexString(),
            after: { quotationNo, enquiryId },
            context: ctx,
          },
          session,
        );
        return q;
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new DomainError(
          'STATE_CONFLICT',
          'This enquiry already has a quotation. Revise it to create a new version.',
        );
      throw err;
    }
  }

  private assertValidity(validUntil: string): void {
    if (validUntil < todayIn())
      throw new DomainError('VALIDATION_FAILED', 'The validity date is in the past.', [
        { path: 'validUntil', message: 'Choose today or a later date' },
      ]);
  }

  async update(
    id: string,
    input: QuotationInput,
    expectedRev: number | undefined,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<QuotationDoc> {
    const q = await this.getDoc(id);
    if (q.status !== 'DRAFT')
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        'Only draft quotations can be edited. Revise it instead.',
      );
    await this.companies.requireActiveSite(q.companyId, input.siteId);
    this.assertValidity(input.validUntil);
    const company = await this.companies.getById(q.companyId);
    const priced = await this.price(company.billingAddress.stateCode, input);
    return this.txn.run(async (session) => {
      const updated = await this.quotations
        .findOneAndUpdate(
          { _id: q._id, status: 'DRAFT', rev: expectedRev ?? q.rev },
          {
            $set: {
              siteId: new Types.ObjectId(input.siteId),
              ...this.pricedFields(priced),
              placeOfSupplyStateCode: company.billingAddress.stateCode,
              billingAddress: company.billingAddress,
              schedule: input.schedule,
              paymentTerms: input.paymentTerms,
              terms: input.terms,
              validUntil: input.validUntil,
            },
            $inc: { rev: 1 },
          },
          { new: true, session },
        )
        .lean<QuotationDoc>()
        .exec();
      if (!updated)
        throw new DomainError(
          'VERSION_MISMATCH',
          'This quotation was changed by someone else. Reload and retry.',
        );
      await this.enquiries.setLatestQuotation(q.enquiryId, this.summaryOf(updated), session);
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'quotation.update',
          entityType: 'Quotation',
          entityId: id,
          after: { totalPaise: updated.totalPaise },
          context: ctx,
        },
        session,
      );
      return updated;
    });
  }

  /** DRAFT -> SENT (FR-QUO-03/05): the company is notified and the PDF is rendered in the background. */
  async send(id: string, user: AuthUser, ctx: AuditContext): Promise<QuotationDoc> {
    const q = await this.getDoc(id);
    if (q.status !== 'DRAFT')
      throw new DomainError('INVALID_STATE_TRANSITION', 'Only draft quotations can be sent.');
    if (q.validUntil < todayIn())
      throw new DomainError('QUOTATION_EXPIRED', 'The validity date has passed. Change it before sending.', [
        { path: 'validUntil' },
      ]);
    const company = await this.companies.requireNotSuspended(q.companyId);
    const admins = await this.companies.adminUserIds(company._id.toHexString());
    return this.txn.run(async (session) => {
      const updated = await this.quotations
        .findOneAndUpdate(
          { _id: q._id, status: 'DRAFT', rev: q.rev },
          { $set: { status: 'SENT', sentAt: new Date() } },
          { new: true, session },
        )
        .lean<QuotationDoc>()
        .exec();
      if (!updated)
        throw new DomainError(
          'CONCURRENT_MODIFICATION',
          'The quotation changed at the same time. Reload and retry.',
        );
      await this.enquiries.transition(q.enquiryId, 'QUOTED', session, this.summaryOf(updated));
      await this.outbox.add(
        { type: 'quotation.sent', aggregateType: 'Quotation', aggregateId: id, payload: { quotationId: id } },
        session,
      );
      await this.notifications.request(
        {
          eventType: 'quotation.sent',
          priority: 'CRITICAL',
          recipients: admins.map((userId) => ({ userId })),
          data: {
            quotationNo: q.quotationNo,
            version: String(q.version),
            amount: (q.totalPaise / 100).toFixed(2),
            validUntil: q.validUntil,
            id,
          },
        },
        session,
      );
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'quotation.send',
          entityType: 'Quotation',
          entityId: id,
          after: { status: 'SENT' },
          context: ctx,
        },
        session,
      );
      return updated;
    });
  }

  /** FR-QUO-02: a new DRAFT version n+1; a SENT version becomes SUPERSEDED. */
  async revise(id: string, user: AuthUser, ctx: AuditContext): Promise<QuotationDoc> {
    const q = await this.getDoc(id);
    if (!q.isLatest) throw new DomainError('QUOTATION_NOT_LATEST', 'Only the latest version can be revised.');
    if (!['SENT', 'REJECTED', 'EXPIRED'].includes(q.status))
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        q.status === 'DRAFT'
          ? 'This version is still a draft; edit it directly.'
          : 'An accepted quotation cannot be revised.',
      );
    const validityDays = await this.config.get('quotation.defaultValidityDays');
    const today = todayIn();
    try {
      return await this.txn.run(async (session) => {
        const old = await this.quotations
          .findOneAndUpdate(
            { _id: q._id, isLatest: true, status: q.status, rev: q.rev },
            {
              $set: { isLatest: false, ...(q.status === 'SENT' ? { status: 'SUPERSEDED' } : {}) },
              $inc: { rev: 1 },
            },
            { new: true, session },
          )
          .lean<QuotationDoc>()
          .exec();
        if (!old)
          throw new DomainError(
            'CONCURRENT_MODIFICATION',
            'The quotation changed at the same time. Reload and retry.',
          );
        const [doc] = await this.quotations.create(
          [
            {
              quotationNo: q.quotationNo,
              enquiryId: q.enquiryId,
              companyId: q.companyId,
              siteId: q.siteId,
              lines: q.lines,
              subtotalPaise: q.subtotalPaise,
              discountPaise: q.discountPaise,
              taxablePaise: q.taxablePaise,
              tax: q.tax,
              totalPaise: q.totalPaise,
              supplierStateCode: q.supplierStateCode,
              placeOfSupplyStateCode: q.placeOfSupplyStateCode,
              billingAddress: q.billingAddress,
              schedule: q.schedule,
              paymentTerms: q.paymentTerms,
              terms: q.terms,
              version: q.version + 1,
              isLatest: true,
              status: 'DRAFT',
              supersedesId: q._id,
              validUntil: q.validUntil >= today ? q.validUntil : addDays(today, validityDays),
              createdBy: new Types.ObjectId(user.id),
              rev: 0,
            },
          ],
          { session },
        );
        const next = (doc as unknown as { toObject(): QuotationDoc }).toObject();
        await this.enquiries.transition(q.enquiryId, 'IN_REVIEW', session, this.summaryOf(next));
        await this.audit.record(
          {
            actor: actorFromUser(user),
            action: 'quotation.revise',
            entityType: 'Quotation',
            entityId: next._id.toHexString(),
            before: { id, version: q.version, status: q.status },
            after: { version: next.version },
            context: ctx,
          },
          session,
        );
        return next;
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new DomainError(
          'CONCURRENT_MODIFICATION',
          'Another revision was created at the same time. Reload.',
        );
      throw err;
    }
  }

  async adminList(
    q: z.infer<typeof quotationListQuerySchema>,
  ): Promise<{ items: QuotationView[]; meta: PageMeta }> {
    const filter: FilterQuery<QuotationDoc> = {};
    if (q.status) filter.status = q.status;
    if (q.enquiryId) filter.enquiryId = new Types.ObjectId(q.enquiryId);
    if (q.companyId) filter.companyId = new Types.ObjectId(q.companyId);
    const { docs, meta } = await findPage(this.quotations, filter, q, { createdAt: -1, version: -1 });
    return { items: await this.toViews(docs, { admin: true }), meta };
  }

  /* ---------------------------------------------------------------- company side (FR-QUO-04) */

  private companyFilter(user: AuthUser): FilterQuery<QuotationDoc> {
    const scope = requireCompanyScope(user);
    // Drafts are internal; companies only ever see what was sent to them.
    return {
      companyId: new Types.ObjectId(scope.companyId),
      status: { $ne: 'DRAFT' },
      ...siteFilterOf(scope),
    };
  }

  async listForCompany(
    user: AuthUser,
    q: z.infer<typeof quotationListQuerySchema>,
  ): Promise<{ items: QuotationView[]; meta: PageMeta }> {
    const filter = this.companyFilter(user);
    if (q.status && q.status !== 'DRAFT') filter.status = q.status;
    if (q.enquiryId) filter.enquiryId = new Types.ObjectId(q.enquiryId);
    const { docs, meta } = await findPage(this.quotations, filter, q, { createdAt: -1, version: -1 });
    return { items: await this.toViews(docs, { admin: false }), meta };
  }

  async getForCompany(user: AuthUser, id: string): Promise<QuotationDoc> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.quotations
          .findOne({ _id: id, ...this.companyFilter(user) })
          .lean<QuotationDoc>()
          .exec()
      : null;
    if (!doc) throw new NotFoundError('Quotation', id);
    return doc;
  }

  /**
   * Accepting creates the job in the same transaction (DATABASE §13): either both exist or
   * neither. Replays with the same Idempotency-Key return the stored response.
   */
  async accept(user: AuthUser, id: string, ctx: AuditContext): Promise<QuotationAcceptResult> {
    const q = await this.getForCompany(user, id);
    if (q.status !== 'SENT' || !q.isLatest)
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        q.status === 'ACCEPTED'
          ? 'This quotation is already accepted.'
          : `This quotation is ${q.status.toLowerCase()} and can no longer be accepted.`,
      );
    if (q.validUntil < todayIn())
      throw new DomainError(
        'QUOTATION_EXPIRED',
        'This quotation has expired. Ask SkillConnect for a revised quotation.',
      );
    const company = await this.companies.requireActive(q.companyId);
    const site = await this.companies.requireActiveSite(company._id, q.siteId.toHexString());
    const enquiry = await this.enquiries.getDoc(q.enquiryId);
    const notify = enquiry.assignedTo
      ? [enquiry.assignedTo.toHexString()]
      : (await this.roles.userIdsWithRole('OPS_ADMIN')).map((u) => u.toHexString());
    const actor = actorFromUser(user);

    const { quotation, job } = await this.txn.run(async (session) => {
      const job = await this.jobs.createFromQuotation(
        {
          company,
          site,
          categoryId: enquiry.categoryId,
          title: `${company.legalName} – ${q.lines
            .map((l) => l.description)
            .slice(0, 2)
            .join(', ')}`.slice(0, 150),
          description: enquiry.description,
          quotation: {
            id: q._id,
            quotationNo: `${q.quotationNo} v${q.version}`,
            schedule: q.schedule,
            paymentTerms: q.paymentTerms,
            lines: q.lines,
          },
          minExperienceBySkill: new Map(
            enquiry.lines.map((l) => [l.skillId.toHexString(), l.minExperienceYears ?? 0]),
          ),
        },
        actor,
        session,
      );
      const quotation = await this.quotations
        .findOneAndUpdate(
          { _id: q._id, status: 'SENT', isLatest: true, rev: q.rev },
          {
            $set: {
              status: 'ACCEPTED',
              jobId: job._id,
              decision: {
                by: new Types.ObjectId(user.id),
                at: new Date(),
                ...(ctx.ip ? { ip: ctx.ip } : {}),
                ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
              },
            },
            $inc: { rev: 1 },
          },
          { new: true, session },
        )
        .lean<QuotationDoc>()
        .exec();
      if (!quotation)
        throw new DomainError(
          'CONCURRENT_MODIFICATION',
          'This quotation changed at the same time. Reload and retry.',
        );
      await this.enquiries.transition(q.enquiryId, 'ACCEPTED', session, this.summaryOf(quotation));
      await this.notifications.request(
        {
          eventType: 'quotation.accepted',
          priority: 'NORMAL',
          recipients: notify.map((userId) => ({ userId })),
          data: {
            quotationNo: q.quotationNo,
            company: company.legalName,
            jobNo: job.jobNo,
            jobId: job._id.toHexString(),
          },
        },
        session,
      );
      await this.audit.record(
        {
          actor,
          action: 'quotation.accept',
          entityType: 'Quotation',
          entityId: id,
          after: { status: 'ACCEPTED', jobId: job._id.toHexString(), ip: ctx.ip },
          context: ctx,
        },
        session,
      );
      return { quotation, job };
    });
    return { quotation: await this.toView(quotation, false), jobId: job._id.toHexString(), jobNo: job.jobNo };
  }

  async reject(user: AuthUser, id: string, reason: string, ctx: AuditContext): Promise<QuotationDoc> {
    const q = await this.getForCompany(user, id);
    if (q.status !== 'SENT' || !q.isLatest)
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `This quotation is ${q.status.toLowerCase()} and cannot be rejected.`,
      );
    const enquiry = await this.enquiries.getDoc(q.enquiryId);
    const notify = enquiry.assignedTo
      ? [enquiry.assignedTo.toHexString()]
      : (await this.roles.userIdsWithRole('OPS_ADMIN')).map((u) => u.toHexString());
    return this.txn.run(async (session) => {
      const updated = await this.quotations
        .findOneAndUpdate(
          { _id: q._id, status: 'SENT', rev: q.rev },
          {
            $set: {
              status: 'REJECTED',
              decision: {
                by: new Types.ObjectId(user.id),
                at: new Date(),
                reason,
                ...(ctx.ip ? { ip: ctx.ip } : {}),
              },
            },
            $inc: { rev: 1 },
          },
          { new: true, session },
        )
        .lean<QuotationDoc>()
        .exec();
      if (!updated)
        throw new DomainError(
          'CONCURRENT_MODIFICATION',
          'This quotation changed at the same time. Reload and retry.',
        );
      await this.enquiries.transition(q.enquiryId, 'REJECTED', session, this.summaryOf(updated));
      await this.notifications.request(
        {
          eventType: 'quotation.rejected',
          priority: 'NORMAL',
          recipients: notify.map((userId) => ({ userId })),
          data: { quotationNo: q.quotationNo, reason },
        },
        session,
      );
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'quotation.reject',
          entityType: 'Quotation',
          entityId: id,
          reason,
          context: ctx,
        },
        session,
      );
      return updated;
    });
  }

  /* ---------------------------------------------------------------- scheduled expiry */

  /** SENT quotations past their validity become EXPIRED, and so do their enquiries. */
  async expireDue(today = todayIn()): Promise<number> {
    const due = await this.quotations
      .find({ status: 'SENT', validUntil: { $lt: today } }, { _id: 1 })
      .limit(500)
      .lean<Pick<QuotationDoc, '_id'>[]>()
      .exec();
    let expired = 0;
    for (const { _id } of due) {
      await this.txn.run(async (session) => {
        const q = await this.quotations
          .findOneAndUpdate(
            { _id, status: 'SENT', validUntil: { $lt: today } },
            { $set: { status: 'EXPIRED' }, $inc: { rev: 1 } },
            { new: true, session },
          )
          .lean<QuotationDoc>()
          .exec();
        if (!q) return;
        expired += 1;
        if (q.isLatest) await this.enquiries.transition(q.enquiryId, 'EXPIRED', session, this.summaryOf(q));
        await this.audit.record(
          {
            actor: { system: 'scheduler:quotation-expiry' },
            action: 'quotation.expire',
            entityType: 'Quotation',
            entityId: _id.toHexString(),
            context: {},
          },
          session,
        );
      });
    }
    if (expired > 0) this.logger.log(`Expired ${expired} quotation(s)`);
    return expired;
  }

  /* ---------------------------------------------------------------- PDF (FR-QUO-05) */

  async ensurePdf(q: QuotationDoc): Promise<QuotationDoc> {
    if (q.pdf && q.pdf.rev === q.rev) return q;
    const [company, sites, supplier, { skills }] = await Promise.all([
      this.companies.getById(q.companyId),
      this.companies.sitesByIds([q.siteId]),
      this.config.get('tax.supplier'),
      this.catalog.nameLookups(),
    ]);
    const buffer = renderQuotationPdf({
      q,
      companyName: company.legalName,
      ...(company.gstin ? { companyGstin: company.gstin } : {}),
      site: sites.get(q.siteId.toHexString()),
      supplier,
      skillName: (id) => skills.get(id)?.name ?? '',
    });
    const key = `exports/${new Types.ObjectId().toHexString()}`;
    await this.storage.putBuffer(key, buffer, 'application/pdf');
    const updated = await this.quotations
      .findOneAndUpdate(
        { _id: q._id, rev: q.rev },
        { $set: { pdf: { key, rev: q.rev, generatedAt: new Date() } } },
        { new: true },
      )
      .lean<QuotationDoc>()
      .exec();
    if (q.pdf) await this.storage.delete(q.pdf.key).catch(() => undefined);
    return updated ?? { ...q, pdf: { key, rev: q.rev, generatedAt: new Date() } };
  }

  async pdfUrl(q: QuotationDoc): Promise<{ url: string }> {
    const withPdf = await this.ensurePdf(q);
    const ttl = await this.config.get('documents.downloadUrlTtlSeconds');
    const url = await this.storage.presignDownload(
      (withPdf.pdf as NonNullable<QuotationDoc['pdf']>).key,
      ttl,
      `${q.quotationNo}-v${q.version}.pdf`,
    );
    return { url };
  }
}

/* ================================================================ controllers */

class QuotationDto extends createZodDto(quotationInputSchema) {}
class PreviewDto extends createZodDto(
  z
    .object({
      lines: z.array(quotationLineInputSchema).min(1).max(50),
      discountPaise: z.number().int().min(0).default(0),
    })
    .strict(),
) {}
class RejectDto extends createZodDto(quotationRejectSchema) {}
class ListDto extends createZodDto(quotationListQuerySchema) {}
class TaxContextDto extends createZodDto(z.object({ companyId: objectIdSchema }).strict()) {}

@ApiTags('Quotations (admin)')
@ApiBearerAuth()
@PlatformOnly()
@Controller('admin')
export class AdminQuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Post('enquiries/:id/quotations')
  @RequirePermissions('quotation.manage')
  @ApiZodBody(QuotationDto)
  async create(
    @Param('id') enquiryId: string,
    @Body() dto: QuotationDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<QuotationView> {
    return this.quotations.toView(await this.quotations.createFromEnquiry(enquiryId, dto, user, ctx), true);
  }

  @Get('quotations')
  @RequirePermissions('quotation.manage')
  @ApiZodQuery(ListDto)
  async list(@Query() q: ListDto): Promise<PagedResult<QuotationView>> {
    const { items, meta } = await this.quotations.adminList(q);
    return new PagedResult(items, meta);
  }

  @Get('quotations/tax-context')
  @RequirePermissions('quotation.manage')
  @ApiZodQuery(TaxContextDto)
  taxContext(@Query() q: TaxContextDto): Promise<QuotationTaxContext> {
    return this.quotations.taxContext(q.companyId);
  }

  @Get('quotations/:id')
  @RequirePermissions('quotation.manage')
  async get(@Param('id') id: string): Promise<QuotationView> {
    return this.quotations.toView(await this.quotations.getDoc(id), true);
  }

  @Patch('quotations/:id')
  @RequirePermissions('quotation.manage')
  @ApiZodBody(QuotationDto)
  async update(
    @Param('id') id: string,
    @Body() dto: QuotationDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<QuotationView> {
    return this.quotations.toView(
      await this.quotations.update(id, dto, parseIfMatch(ifMatch), user, ctx),
      true,
    );
  }

  @Post('quotations/:id/preview-totals')
  @HttpCode(200)
  @RequirePermissions('quotation.manage')
  @ApiZodBody(PreviewDto)
  preview(@Param('id') id: string, @Body() dto: PreviewDto): Promise<TaxTotals> {
    return this.quotations.previewTotals(id, dto);
  }

  @Post('quotations/:id/send')
  @HttpCode(200)
  @RequirePermissions('quotation.manage')
  async send(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<QuotationView> {
    return this.quotations.toView(await this.quotations.send(id, user, ctx), true);
  }

  @Post('quotations/:id/revise')
  @HttpCode(200)
  @RequirePermissions('quotation.manage')
  async revise(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<QuotationView> {
    return this.quotations.toView(await this.quotations.revise(id, user, ctx), true);
  }

  @Get('quotations/:id/pdf-url')
  @RequirePermissions('quotation.manage')
  async pdf(@Param('id') id: string): Promise<{ url: string }> {
    return this.quotations.pdfUrl(await this.quotations.getDoc(id));
  }
}

@ApiTags('Quotations')
@ApiBearerAuth()
@Controller('quotations')
export class CompanyQuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Get()
  @RequirePermissions('quotation.decide')
  @ApiZodQuery(ListDto)
  async list(@Query() q: ListDto, @CurrentUser() user: AuthUser): Promise<PagedResult<QuotationView>> {
    const { items, meta } = await this.quotations.listForCompany(user, q);
    return new PagedResult(items, meta);
  }

  @Get(':id')
  @RequirePermissions('quotation.decide')
  async get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<QuotationView> {
    return this.quotations.toView(await this.quotations.getForCompany(user, id), false);
  }

  @Get(':id/pdf-url')
  @RequirePermissions('quotation.decide')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<{ url: string }> {
    return this.quotations.pdfUrl(await this.quotations.getForCompany(user, id));
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermissions('quotation.decide')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  accept(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<QuotationAcceptResult> {
    return this.quotations.accept(user, id, ctx);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions('quotation.decide')
  @ApiZodBody(RejectDto)
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<QuotationView> {
    return this.quotations.toView(await this.quotations.reject(user, id, dto.reason, ctx), false);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([{ name: QUOTATION_MODEL, schema: quotationSchema }]),
    UsersModule,
    CatalogModule,
    CompaniesModule,
    EnquiriesModule,
    JobsModule,
    NotificationsModule,
  ],
  controllers: [AdminQuotationsController, CompanyQuotationsController],
  providers: [QuotationsService],
  exports: [QuotationsService],
})
export class QuotationsModule {}
