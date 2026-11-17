import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Schema, Types, type ClientSession, type FilterQuery, type Model } from 'mongoose';
import type { z } from 'zod';
import {
  adminEnquiryCreateSchema,
  canTransitionEnquiry,
  companyEnquiryListQuerySchema,
  convertLeadSchema,
  ENQUIRY_SOURCES,
  ENQUIRY_STATUSES,
  enquiryAssignSchema,
  enquiryCancelSchema,
  enquiryCreateSchema,
  enquiryListQuerySchema,
  enquiryNoteSchema,
  enquiryStatusSchema,
  enquiryUpdateSchema,
  publicEnquirySchema,
  type EnquiryCreateInput,
  type EnquirySchedule,
  type EnquirySource,
  type EnquiryStatus,
  type EnquiryUpdateInput,
  type EnquiryView,
  type PageMeta,
  type QuotationStatus,
} from '@skillconnect/contracts';
import {
  actorFromUser,
  AuditService,
  type AuditActor,
  type AuditContext,
} from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, PlatformOnly, Public, RequirePermissions } from '../../core/auth/decorators';
import { RateLimit } from '../../core/auth/rate-limit';
import { BusinessConfigService } from '../../core/business-config/business-config.service';
import { containsText, findPage } from '../../core/database/query';
import { SequenceService } from '../../core/database/sequence.service';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { parseIfMatch } from '../../core/http/if-match';
import { ReqContext } from '../../core/http/request-context';
import { PagedResult } from '../../core/http/response-envelope.interceptor';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';
import { CatalogModule, CatalogService } from '../catalog/catalog.module';
import {
  CompaniesModule,
  CompaniesService,
  requireCompanyScope,
  siteFilterOf,
} from '../companies/companies.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationsService } from '../notifications/notifications.service';
import { RolesService } from '../users/roles.service';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

/* ================================================================ schema (DATABASE §8) */

export const ENQUIRY_MODEL = 'Enquiry';

interface LeadInfo {
  name: string;
  companyName: string;
  mobile: string;
  email?: string;
  city: string;
}

export interface EnquiryDoc {
  _id: Types.ObjectId;
  enquiryNo: string;
  source: EnquirySource;
  companyId?: Types.ObjectId;
  lead?: LeadInfo;
  categoryId: Types.ObjectId;
  siteId?: Types.ObjectId;
  lines: Array<{ skillId: Types.ObjectId; headcount: number; minExperienceYears?: number; notes?: string }>;
  schedule: EnquirySchedule;
  description: string;
  budgetPaise?: number;
  status: EnquiryStatus;
  statusReason?: string;
  assignedTo?: Types.ObjectId;
  notes: Array<{ by: Types.ObjectId; at: Date; text: string }>;
  /** Denormalised by Quotations so lists need no join (and no circular module import). */
  latestQuotation?: {
    id: Types.ObjectId;
    quotationNo: string;
    version: number;
    status: QuotationStatus;
    totalPaise: number;
  };
  createdBy?: Types.ObjectId;
  version: number;
  createdAt: Date;
}

const enquirySchema = new Schema<EnquiryDoc>(
  {
    enquiryNo: { type: String, required: true },
    source: { type: String, enum: ENQUIRY_SOURCES, required: true },
    companyId: Schema.Types.ObjectId,
    lead: {
      type: new Schema(
        { name: String, companyName: String, mobile: String, email: String, city: String },
        { _id: false },
      ),
    },
    categoryId: { type: Schema.Types.ObjectId, required: true },
    siteId: Schema.Types.ObjectId,
    lines: {
      type: [
        new Schema(
          { skillId: Schema.Types.ObjectId, headcount: Number, minExperienceYears: Number, notes: String },
          { _id: false },
        ),
      ],
      required: true,
    },
    schedule: { type: Schema.Types.Mixed, required: true },
    description: { type: String, required: true },
    budgetPaise: Number,
    status: { type: String, enum: ENQUIRY_STATUSES, required: true, default: 'NEW' },
    statusReason: String,
    assignedTo: Schema.Types.ObjectId,
    notes: {
      type: [new Schema({ by: Schema.Types.ObjectId, at: Date, text: String }, { _id: false })],
      default: [],
    },
    latestQuotation: {
      type: new Schema(
        {
          id: Schema.Types.ObjectId,
          quotationNo: String,
          version: Number,
          status: String,
          totalPaise: Number,
        },
        { _id: false },
      ),
    },
    createdBy: Schema.Types.ObjectId,
    version: { type: Number, default: 0 },
  },
  { collection: 'enquiries', timestamps: true, versionKey: false },
);
enquirySchema.index({ enquiryNo: 1 }, { unique: true });
enquirySchema.index({ companyId: 1, createdAt: -1 });
enquirySchema.index({ status: 1, assignedTo: 1, createdAt: -1 });
enquirySchema.index({ 'lead.mobile': 1 }, { sparse: true });

const OPEN_STATUSES: EnquiryStatus[] = ['NEW', 'IN_REVIEW'];

/* ================================================================ service */

@Injectable()
export class EnquiriesService {
  constructor(
    @InjectModel(ENQUIRY_MODEL) private readonly enquiries: Model<EnquiryDoc>,
    private readonly companies: CompaniesService,
    private readonly catalog: CatalogService,
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly notifications: NotificationsService,
    private readonly sequences: SequenceService,
    private readonly config: BusinessConfigService,
    private readonly txn: TransactionRunner,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------- views */

  async toViews(docs: EnquiryDoc[], opts: { admin: boolean }): Promise<EnquiryView[]> {
    if (docs.length === 0) return [];
    const { categories, skills } = await this.catalog.nameLookups();
    const companyNames = await this.companies.namesByIds(
      docs.flatMap((d) => (d.companyId ? [d.companyId] : [])),
    );
    const sites = await this.companies.sitesByIds(docs.flatMap((d) => (d.siteId ? [d.siteId] : [])));
    const userIds = new Set<string>();
    for (const d of docs) {
      if (d.assignedTo) userIds.add(d.assignedTo.toHexString());
      if (opts.admin) for (const n of d.notes) userIds.add(n.by.toHexString());
    }
    const people = new Map(
      (await this.users.findByIds([...userIds])).map((u) => [u._id.toHexString(), u.name]),
    );
    return docs.map((d) => {
      const companyId = d.companyId?.toHexString();
      const siteId = d.siteId?.toHexString();
      const assigned = d.assignedTo?.toHexString();
      return {
        id: d._id.toHexString(),
        enquiryNo: d.enquiryNo,
        source: d.source,
        ...(companyId ? { companyId, companyName: companyNames.get(companyId) ?? '' } : {}),
        ...(d.lead && opts.admin ? { lead: d.lead } : {}),
        categoryId: d.categoryId.toHexString(),
        categoryName: categories.get(d.categoryId.toHexString()) ?? '',
        ...(siteId ? { siteId, siteName: sites.get(siteId)?.name ?? '' } : {}),
        lines: d.lines.map((l) => ({
          skillId: l.skillId.toHexString(),
          skillName: skills.get(l.skillId.toHexString())?.name ?? '',
          headcount: l.headcount,
          ...(l.minExperienceYears !== undefined ? { minExperienceYears: l.minExperienceYears } : {}),
          ...(l.notes ? { notes: l.notes } : {}),
        })),
        schedule: d.schedule,
        description: d.description,
        ...(d.budgetPaise !== undefined ? { budgetPaise: d.budgetPaise } : {}),
        status: d.status,
        ...(d.statusReason ? { statusReason: d.statusReason } : {}),
        ...(assigned && opts.admin ? { assignedTo: { id: assigned, name: people.get(assigned) ?? '' } } : {}),
        ...(opts.admin
          ? {
              notes: d.notes.map((n) => ({
                by: n.by.toHexString(),
                byName: people.get(n.by.toHexString()) ?? '',
                at: n.at.toISOString(),
                text: n.text,
              })),
            }
          : {}),
        ...(d.latestQuotation && (opts.admin || d.latestQuotation.status !== 'DRAFT')
          ? {
              latestQuotation: {
                id: d.latestQuotation.id.toHexString(),
                quotationNo: d.latestQuotation.quotationNo,
                version: d.latestQuotation.version,
                status: d.latestQuotation.status,
                totalPaise: d.latestQuotation.totalPaise,
              },
            }
          : {}),
        createdAt: d.createdAt.toISOString(),
        version: d.version,
      };
    });
  }

  async toView(doc: EnquiryDoc, admin: boolean): Promise<EnquiryView> {
    const [view] = await this.toViews([doc], { admin });
    return view as EnquiryView;
  }

  /* ---------------------------------------------------------------- lookups for Quotations */

  async getDoc(id: string | Types.ObjectId, session?: ClientSession): Promise<EnquiryDoc> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.enquiries.findById(id, undefined, { session }).lean<EnquiryDoc>().exec()
      : null;
    if (!doc) throw new NotFoundError('Enquiry', String(id));
    return doc;
  }

  /** State change driven by the quotation lifecycle, inside the caller's transaction. */
  async transition(
    id: Types.ObjectId,
    to: EnquiryStatus,
    session: ClientSession,
    latestQuotation?: EnquiryDoc['latestQuotation'],
  ): Promise<void> {
    const doc = await this.getDoc(id, session);
    if (doc.status !== to && !canTransitionEnquiry(doc.status, to))
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `The enquiry is ${doc.status.toLowerCase()} and cannot become ${to.toLowerCase()}.`,
      );
    const res = await this.enquiries.updateOne(
      { _id: id, version: doc.version },
      { $set: { status: to, ...(latestQuotation ? { latestQuotation } : {}) }, $inc: { version: 1 } },
      { session },
    );
    if (res.matchedCount === 0)
      throw new DomainError('CONCURRENT_MODIFICATION', 'The enquiry changed at the same time. Retry.');
  }

  async setLatestQuotation(
    id: Types.ObjectId,
    latest: NonNullable<EnquiryDoc['latestQuotation']>,
    session: ClientSession,
  ): Promise<void> {
    await this.enquiries.updateOne({ _id: id }, { $set: { latestQuotation: latest } }, { session });
  }

  /* ---------------------------------------------------------------- creation (FR-ENQ-01) */

  private async validateBody(input: Pick<EnquiryCreateInput, 'categoryId' | 'lines'>): Promise<void> {
    await this.catalog.assertCategoriesExist([input.categoryId]);
    await this.catalog.assertActiveSkills(input.lines.map((l) => l.skillId));
  }

  private linesOf(input: Pick<EnquiryCreateInput, 'lines'>): EnquiryDoc['lines'] {
    return input.lines.map((l) => ({ ...l, skillId: new Types.ObjectId(l.skillId) }));
  }

  private async insert(
    data: Omit<EnquiryDoc, '_id' | 'enquiryNo' | 'status' | 'notes' | 'version' | 'createdAt'>,
    actor: AuditActor,
    ctx: AuditContext,
  ): Promise<EnquiryDoc> {
    const prefix = await this.config.get('enquiry.prefix');
    const opsAdmins = await this.roles.userIdsWithRole('OPS_ADMIN');
    return this.txn.run(async (session) => {
      const enquiryNo = await this.sequences.formatted('enquiry', prefix, 6, session);
      const [doc] = await this.enquiries.create([{ ...data, enquiryNo, status: 'NEW', notes: [] }], {
        session,
      });
      const enquiry = (doc as unknown as { toObject(): EnquiryDoc }).toObject();
      await this.notifications.request(
        {
          eventType: 'enquiry.received',
          priority: 'NORMAL',
          recipients: opsAdmins.map((u) => ({ userId: u.toHexString() })),
          data: { enquiryNo, source: data.source, id: enquiry._id.toHexString() },
        },
        session,
      );
      await this.audit.record(
        {
          actor,
          action: 'enquiry.create',
          entityType: 'Enquiry',
          entityId: enquiry._id.toHexString(),
          after: { enquiryNo, source: data.source, companyId: data.companyId?.toHexString() },
          context: ctx,
        },
        session,
      );
      return enquiry;
    });
  }

  async createForCompany(user: AuthUser, input: EnquiryCreateInput, ctx: AuditContext): Promise<EnquiryDoc> {
    const scope = requireCompanyScope(user);
    const company = await this.companies.requireNotSuspended(scope.companyId);
    if (scope.siteIds && !scope.siteIds.includes(input.siteId)) throw new NotFoundError('Site', input.siteId);
    await this.companies.requireActiveSite(company._id, input.siteId);
    await this.validateBody(input);
    return this.insert(
      {
        source: 'COMPANY',
        companyId: company._id,
        categoryId: new Types.ObjectId(input.categoryId),
        siteId: new Types.ObjectId(input.siteId),
        lines: this.linesOf(input),
        schedule: input.schedule,
        description: input.description,
        ...(input.budgetPaise !== undefined ? { budgetPaise: input.budgetPaise } : {}),
        createdBy: new Types.ObjectId(user.id),
      },
      actorFromUser(user),
      ctx,
    );
  }

  async createByAdmin(
    user: AuthUser,
    input: z.infer<typeof adminEnquiryCreateSchema>,
    ctx: AuditContext,
  ): Promise<EnquiryDoc> {
    const company = await this.companies.requireNotSuspended(input.companyId);
    await this.companies.requireActiveSite(company._id, input.siteId);
    await this.validateBody(input);
    return this.insert(
      {
        source: 'ADMIN',
        companyId: company._id,
        categoryId: new Types.ObjectId(input.categoryId),
        siteId: new Types.ObjectId(input.siteId),
        lines: this.linesOf(input),
        schedule: input.schedule,
        description: input.description,
        ...(input.budgetPaise !== undefined ? { budgetPaise: input.budgetPaise } : {}),
        createdBy: new Types.ObjectId(user.id),
        assignedTo: new Types.ObjectId(user.id),
      },
      actorFromUser(user),
      ctx,
    );
  }

  /** Public lead intake (FR-ENQ-01/04). The honeypot is checked by the schema (must be empty). */
  async createLead(
    input: z.infer<typeof publicEnquirySchema>,
    ctx: AuditContext,
  ): Promise<{ enquiryNo: string }> {
    await this.validateBody(input);
    const doc = await this.insert(
      {
        source: 'PUBLIC_LEAD',
        lead: input.lead,
        categoryId: new Types.ObjectId(input.categoryId),
        lines: this.linesOf(input),
        schedule: input.schedule,
        description: input.description,
        ...(input.budgetPaise !== undefined ? { budgetPaise: input.budgetPaise } : {}),
      },
      { system: 'public-enquiry' },
      ctx,
    );
    return { enquiryNo: doc.enquiryNo };
  }

  /* ---------------------------------------------------------------- company side */

  private companyFilter(user: AuthUser): FilterQuery<EnquiryDoc> {
    const scope = requireCompanyScope(user);
    return { companyId: new Types.ObjectId(scope.companyId), ...siteFilterOf(scope) };
  }

  async listForCompany(
    user: AuthUser,
    q: z.infer<typeof companyEnquiryListQuerySchema>,
  ): Promise<{ items: EnquiryView[]; meta: PageMeta }> {
    const filter = this.companyFilter(user);
    if (q.status) filter.status = q.status;
    const { docs, meta } = await findPage(this.enquiries, filter, q);
    return { items: await this.toViews(docs, { admin: false }), meta };
  }

  async getForCompany(user: AuthUser, id: string): Promise<EnquiryDoc> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.enquiries
          .findOne({ _id: id, ...this.companyFilter(user) })
          .lean<EnquiryDoc>()
          .exec()
      : null;
    if (!doc) throw new NotFoundError('Enquiry', id);
    return doc;
  }

  async cancelByCompany(user: AuthUser, id: string, reason: string, ctx: AuditContext): Promise<EnquiryDoc> {
    const doc = await this.getForCompany(user, id);
    if (!OPEN_STATUSES.includes(doc.status))
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        doc.status === 'QUOTED'
          ? 'A quotation has been sent for this enquiry. Reject the quotation instead.'
          : 'This enquiry can no longer be cancelled.',
      );
    return this.applyStatus(doc, 'CANCELLED', reason, actorFromUser(user), ctx);
  }

  /* ---------------------------------------------------------------- admin side (FR-ENQ-03) */

  async adminList(
    q: z.infer<typeof enquiryListQuerySchema>,
    user: AuthUser,
  ): Promise<{ items: EnquiryView[]; meta: PageMeta }> {
    const filter: FilterQuery<EnquiryDoc> = {};
    if (q.status) filter.status = q.status;
    if (q.source) filter.source = q.source;
    if (q.companyId) filter.companyId = new Types.ObjectId(q.companyId);
    if (q.assignedTo === 'me') filter.assignedTo = new Types.ObjectId(user.id);
    else if (q.assignedTo === 'none') filter.assignedTo = { $exists: false };
    else if (q.assignedTo) filter.assignedTo = new Types.ObjectId(q.assignedTo);
    if (q.q)
      filter.$or = [
        { enquiryNo: containsText(q.q) },
        { 'lead.companyName': containsText(q.q) },
        { description: containsText(q.q) },
      ];
    const { docs, meta } = await findPage(this.enquiries, filter, q);
    return { items: await this.toViews(docs, { admin: true }), meta };
  }

  async update(
    id: string,
    input: EnquiryUpdateInput,
    expectedVersion: number | undefined,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<EnquiryDoc> {
    const doc = await this.getDoc(id);
    if (!OPEN_STATUSES.includes(doc.status))
      throw new DomainError('INVALID_STATE_TRANSITION', 'Only new or in-review enquiries can be edited.');
    if (input.categoryId || input.lines)
      await this.validateBody({
        categoryId: input.categoryId ?? doc.categoryId.toHexString(),
        lines: input.lines ?? [],
      });
    if (input.siteId) {
      if (!doc.companyId)
        throw new DomainError('LEAD_NOT_CONVERTED', 'Convert the lead to a company before choosing a site.');
      await this.companies.requireActiveSite(doc.companyId, input.siteId);
    }
    const set: Record<string, unknown> = { ...input };
    if (input.categoryId) set.categoryId = new Types.ObjectId(input.categoryId);
    if (input.siteId) set.siteId = new Types.ObjectId(input.siteId);
    if (input.lines) set.lines = this.linesOf({ lines: input.lines });
    const updated = await this.enquiries
      .findOneAndUpdate(
        { _id: doc._id, version: expectedVersion ?? doc.version, status: { $in: OPEN_STATUSES } },
        { $set: set, $inc: { version: 1 } },
        { new: true },
      )
      .lean<EnquiryDoc>()
      .exec();
    if (!updated)
      throw new DomainError(
        'VERSION_MISMATCH',
        'This enquiry was changed by someone else. Reload and retry.',
      );
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'enquiry.update',
      entityType: 'Enquiry',
      entityId: id,
      after: { fields: Object.keys(input) },
      context: ctx,
    });
    return updated;
  }

  async assign(id: string, userId: string | null, user: AuthUser, ctx: AuditContext): Promise<EnquiryDoc> {
    const doc = await this.getDoc(id);
    if (userId) {
      const assignee = await this.users.findById(userId);
      if (!assignee || assignee.userType !== 'ADMIN' || assignee.status !== 'ACTIVE')
        throw new DomainError('VALIDATION_FAILED', 'Choose an active admin.', [{ field: 'userId' }]);
      const access = await this.roles.accessFor(assignee._id);
      if (!access.permissions.has('enquiry.manage'))
        throw new DomainError('VALIDATION_FAILED', 'This admin cannot handle enquiries.', [
          { field: 'userId' },
        ]);
    }
    return this.txn.run(async (session) => {
      const updated = await this.enquiries
        .findOneAndUpdate(
          { _id: doc._id },
          userId
            ? {
                $set: {
                  assignedTo: new Types.ObjectId(userId),
                  // Picking an enquiry up moves it into review.
                  ...(doc.status === 'NEW' ? { status: 'IN_REVIEW' } : {}),
                },
                $inc: { version: 1 },
              }
            : { $unset: { assignedTo: 1 }, $inc: { version: 1 } },
          { new: true, session },
        )
        .lean<EnquiryDoc>()
        .exec();
      if (userId && userId !== user.id)
        await this.notifications.request(
          {
            eventType: 'enquiry.assigned',
            priority: 'NORMAL',
            recipients: [{ userId }],
            data: { enquiryNo: doc.enquiryNo, id },
          },
          session,
        );
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'enquiry.assign',
          entityType: 'Enquiry',
          entityId: id,
          before: { assignedTo: doc.assignedTo?.toHexString() ?? null },
          after: { assignedTo: userId },
          context: ctx,
        },
        session,
      );
      return updated as EnquiryDoc;
    });
  }

  async addNote(id: string, text: string, user: AuthUser): Promise<EnquiryDoc> {
    const doc = await this.getDoc(id);
    const updated = await this.enquiries
      .findOneAndUpdate(
        { _id: doc._id },
        { $push: { notes: { by: new Types.ObjectId(user.id), at: new Date(), text } } },
        { new: true },
      )
      .lean<EnquiryDoc>()
      .exec();
    return updated as EnquiryDoc;
  }

  async setStatusManually(
    id: string,
    input: z.infer<typeof enquiryStatusSchema>,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<EnquiryDoc> {
    const doc = await this.getDoc(id);
    if (doc.status === 'QUOTED' && input.status !== 'CANCELLED')
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        'A quotation is out with the company; wait for its decision.',
      );
    if (!canTransitionEnquiry(doc.status, input.status))
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `The enquiry is ${doc.status.toLowerCase()} and cannot become ${input.status.toLowerCase()}.`,
      );
    return this.applyStatus(doc, input.status, input.reason, actorFromUser(user), ctx);
  }

  private async applyStatus(
    doc: EnquiryDoc,
    to: EnquiryStatus,
    reason: string | undefined,
    actor: AuditActor,
    ctx: AuditContext,
  ): Promise<EnquiryDoc> {
    const updated = await this.enquiries
      .findOneAndUpdate(
        { _id: doc._id, version: doc.version },
        { $set: { status: to, ...(reason ? { statusReason: reason } : {}) }, $inc: { version: 1 } },
        { new: true },
      )
      .lean<EnquiryDoc>()
      .exec();
    if (!updated)
      throw new DomainError('VERSION_MISMATCH', 'This enquiry changed at the same time. Reload and retry.');
    await this.audit.record({
      actor,
      action: 'enquiry.status',
      entityType: 'Enquiry',
      entityId: doc._id.toHexString(),
      before: { status: doc.status },
      after: { status: to },
      ...(reason ? { reason } : {}),
      context: ctx,
    });
    return updated;
  }

  /** FR-ENQ-04: a lead must belong to a company before it can be quoted. */
  async convertLead(
    id: string,
    input: z.infer<typeof convertLeadSchema>,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<EnquiryDoc> {
    const doc = await this.getDoc(id);
    if (doc.source !== 'PUBLIC_LEAD' || doc.companyId)
      throw new DomainError('STATE_CONFLICT', 'This enquiry already belongs to a company.');
    if (!OPEN_STATUSES.includes(doc.status))
      throw new DomainError('INVALID_STATE_TRANSITION', 'Only new or in-review leads can be converted.');
    const lead = doc.lead as LeadInfo;
    const actor = actorFromUser(user);
    const companyId = await this.txn.run(async (session) => {
      const company = input.companyId
        ? await this.companies.requireNotSuspended(input.companyId, session)
        : await this.companies.createForContact(
            input.newCompany as NonNullable<typeof input.newCompany>,
            { name: lead.name, mobile: lead.mobile, ...(lead.email ? { email: lead.email } : {}) },
            actor,
            ctx,
            session,
          );
      const res = await this.enquiries.updateOne(
        { _id: doc._id, version: doc.version, companyId: { $exists: false } },
        {
          $set: {
            companyId: company._id,
            status: 'IN_REVIEW',
            ...(doc.assignedTo ? {} : { assignedTo: new Types.ObjectId(user.id) }),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (res.matchedCount === 0)
        throw new DomainError('VERSION_MISMATCH', 'This enquiry changed at the same time. Reload and retry.');
      await this.audit.record(
        {
          actor,
          action: 'enquiry.convert_lead',
          entityType: 'Enquiry',
          entityId: id,
          after: { companyId: company._id.toHexString(), newCompany: !input.companyId },
          context: ctx,
        },
        session,
      );
      return company._id;
    });
    if (input.site) {
      const site = await this.companies.createSite(companyId.toHexString(), input.site, actor, ctx);
      await this.enquiries.updateOne(
        { _id: doc._id },
        { $set: { siteId: new Types.ObjectId(site.id) }, $inc: { version: 1 } },
      );
    }
    return this.getDoc(doc._id);
  }
}

/* ================================================================ controllers */

class EnquiryCreateDto extends createZodDto(enquiryCreateSchema) {}
class AdminEnquiryCreateDto extends createZodDto(adminEnquiryCreateSchema) {}
class PublicEnquiryDto extends createZodDto(publicEnquirySchema) {}
class EnquiryUpdateDto extends createZodDto(enquiryUpdateSchema) {}
class AssignDto extends createZodDto(enquiryAssignSchema) {}
class NoteDto extends createZodDto(enquiryNoteSchema) {}
class StatusDto extends createZodDto(enquiryStatusSchema) {}
class CancelDto extends createZodDto(enquiryCancelSchema) {}
class ConvertDto extends createZodDto(convertLeadSchema) {}
class AdminListDto extends createZodDto(enquiryListQuerySchema) {}
class CompanyListDto extends createZodDto(companyEnquiryListQuerySchema) {}

@ApiTags('Enquiries')
@Controller()
export class EnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Public()
  @Post('public/enquiries')
  @RateLimit({ name: 'public-enquiry', limit: 5, windowSeconds: 3600, by: 'ip' })
  @ApiZodBody(PublicEnquiryDto)
  lead(@Body() dto: PublicEnquiryDto, @ReqContext() ctx: AuditContext): Promise<{ enquiryNo: string }> {
    return this.enquiries.createLead(dto, ctx);
  }

  @ApiBearerAuth()
  @Get('enquiries')
  @RequirePermissions('enquiry.create')
  @ApiZodQuery(CompanyListDto)
  async list(@Query() q: CompanyListDto, @CurrentUser() user: AuthUser): Promise<PagedResult<EnquiryView>> {
    const { items, meta } = await this.enquiries.listForCompany(user, q);
    return new PagedResult(items, meta);
  }

  @ApiBearerAuth()
  @Post('enquiries')
  @RequirePermissions('enquiry.create')
  @ApiZodBody(EnquiryCreateDto)
  async create(
    @Body() dto: EnquiryCreateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<EnquiryView> {
    return this.enquiries.toView(await this.enquiries.createForCompany(user, dto, ctx), false);
  }

  @ApiBearerAuth()
  @Get('enquiries/:id')
  @RequirePermissions('enquiry.create')
  async get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<EnquiryView> {
    return this.enquiries.toView(await this.enquiries.getForCompany(user, id), false);
  }

  @ApiBearerAuth()
  @Post('enquiries/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('enquiry.create')
  @ApiZodBody(CancelDto)
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<EnquiryView> {
    return this.enquiries.toView(await this.enquiries.cancelByCompany(user, id, dto.reason, ctx), false);
  }
}

@ApiTags('Enquiries (admin)')
@ApiBearerAuth()
@PlatformOnly()
@Controller('admin/enquiries')
export class AdminEnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Get()
  @RequirePermissions('enquiry.manage')
  @ApiZodQuery(AdminListDto)
  async list(@Query() q: AdminListDto, @CurrentUser() user: AuthUser): Promise<PagedResult<EnquiryView>> {
    const { items, meta } = await this.enquiries.adminList(q, user);
    return new PagedResult(items, meta);
  }

  @Post()
  @RequirePermissions('enquiry.manage')
  @ApiZodBody(AdminEnquiryCreateDto)
  async create(
    @Body() dto: AdminEnquiryCreateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<EnquiryView> {
    return this.enquiries.toView(await this.enquiries.createByAdmin(user, dto, ctx), true);
  }

  @Get(':id')
  @RequirePermissions('enquiry.manage')
  async get(@Param('id') id: string): Promise<EnquiryView> {
    return this.enquiries.toView(await this.enquiries.getDoc(id), true);
  }

  @Patch(':id')
  @RequirePermissions('enquiry.manage')
  @ApiZodBody(EnquiryUpdateDto)
  async update(
    @Param('id') id: string,
    @Body() dto: EnquiryUpdateDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<EnquiryView> {
    return this.enquiries.toView(
      await this.enquiries.update(id, dto, parseIfMatch(ifMatch), user, ctx),
      true,
    );
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermissions('enquiry.manage')
  @ApiZodBody(AssignDto)
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<EnquiryView> {
    return this.enquiries.toView(await this.enquiries.assign(id, dto.userId, user, ctx), true);
  }

  @Post(':id/notes')
  @HttpCode(200)
  @RequirePermissions('enquiry.manage')
  @ApiZodBody(NoteDto)
  async note(
    @Param('id') id: string,
    @Body() dto: NoteDto,
    @CurrentUser() user: AuthUser,
  ): Promise<EnquiryView> {
    return this.enquiries.toView(await this.enquiries.addNote(id, dto.text, user), true);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions('enquiry.manage')
  @ApiZodBody(StatusDto)
  async status(
    @Param('id') id: string,
    @Body() dto: StatusDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<EnquiryView> {
    return this.enquiries.toView(await this.enquiries.setStatusManually(id, dto, user, ctx), true);
  }

  @Post(':id/convert-lead')
  @HttpCode(200)
  @RequirePermissions('enquiry.manage')
  @ApiZodBody(ConvertDto)
  async convert(
    @Param('id') id: string,
    @Body() dto: ConvertDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<EnquiryView> {
    return this.enquiries.toView(await this.enquiries.convertLead(id, dto, user, ctx), true);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ENQUIRY_MODEL, schema: enquirySchema }]),
    UsersModule,
    CatalogModule,
    CompaniesModule,
    NotificationsModule,
  ],
  controllers: [EnquiriesController, AdminEnquiriesController],
  providers: [EnquiriesService],
  exports: [EnquiriesService],
})
export class EnquiriesModule {}
