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
  BILLING_BASES,
  companyJobListQuerySchema,
  JOB_STATUSES,
  jobCreateSchema,
  jobListQuerySchema,
  jobReasonSchema,
  jobUpdateSchema,
  LIVE_JOB_STATUSES,
  type BillingBasis,
  type JobSchedule,
  type JobStatus,
  type JobUpdateResult,
  type JobView,
  type PageMeta,
  type PaymentTerms,
  type QuotationSchedule,
} from '@bijliwala/contracts';
import {
  actorFromUser,
  AuditService,
  type AuditActor,
  type AuditContext,
} from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, PlatformOnly, RequirePermissions } from '../../core/auth/decorators';
import { BusinessConfigService } from '../../core/business-config/business-config.service';
import { containsText, findPage, todayIn } from '../../core/database/query';
import { SequenceService } from '../../core/database/sequence.service';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { parseIfMatch } from '../../core/http/if-match';
import { ReqContext } from '../../core/http/request-context';
import { PagedResult } from '../../core/http/response-envelope.interceptor';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';
import { OutboxService } from '../../core/outbox/outbox.service';
import { CatalogModule, CatalogService } from '../catalog/catalog.module';
import {
  CompaniesModule,
  CompaniesService,
  requireCompanyScope,
  siteFilterOf,
  type CompanyDoc,
  type SiteDoc,
} from '../companies/companies.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationsService } from '../notifications/notifications.service';
import {
  assertJobTransition,
  newPosition,
  planJobEdit,
  resumeTargetOf,
  staffingStatusAfterEdit,
  type PositionDoc,
} from './domain';

/* ================================================================ schema (DATABASE §9) */

export const JOB_MODEL = 'Job';

export interface JobDoc {
  _id: Types.ObjectId;
  jobNo: string;
  companyId: Types.ObjectId;
  siteId: Types.ObjectId;
  categoryId: Types.ObjectId;
  quotationId?: Types.ObjectId;
  quotationNo?: string;
  title: string;
  description?: string;
  instructions?: string;
  schedule: JobSchedule;
  positions: PositionDoc[];
  billingBasis: BillingBasis;
  status: JobStatus;
  statusHistory: Array<{ from: string; to: string; by?: Types.ObjectId; at: Date; reason?: string }>;
  cancellation?: { by: Types.ObjectId; at: Date; reason: string };
  createdBy?: Types.ObjectId;
  version: number;
  createdAt: Date;
}

const positionSchema = new Schema<PositionDoc>({
  skillId: { type: Schema.Types.ObjectId, required: true },
  title: { type: String, required: true },
  minExperienceYears: { type: Number, default: 0 },
  requiredCertDocTypeCodes: { type: [String], default: [] },
  shift: { type: new Schema({ startMin: Number, endMin: Number }, { _id: false }), required: true },
  required: { type: Number, required: true, min: 1 },
  held: { type: Number, required: true, default: 0, min: 0 },
  confirmed: { type: Number, required: true, default: 0, min: 0 },
  available: { type: Number, required: true, min: 0 },
  billRatePaise: { type: Number, required: true },
  billUnit: { type: String, required: true },
  payRatePaise: Number,
  showPayRate: { type: Boolean, default: false },
  allowPartialAvailability: { type: Boolean, default: false },
});

const jobSchema = new Schema<JobDoc>(
  {
    jobNo: { type: String, required: true },
    companyId: { type: Schema.Types.ObjectId, required: true },
    siteId: { type: Schema.Types.ObjectId, required: true },
    categoryId: { type: Schema.Types.ObjectId, required: true },
    quotationId: Schema.Types.ObjectId,
    quotationNo: String,
    title: { type: String, required: true },
    description: String,
    instructions: String,
    schedule: { type: Schema.Types.Mixed, required: true },
    positions: { type: [positionSchema], required: true },
    billingBasis: { type: String, enum: BILLING_BASES, required: true },
    status: { type: String, enum: JOB_STATUSES, required: true },
    statusHistory: {
      type: [
        new Schema(
          { from: String, to: String, by: Schema.Types.ObjectId, at: Date, reason: String },
          { _id: false },
        ),
      ],
      default: [],
    },
    cancellation: {
      type: new Schema({ by: Schema.Types.ObjectId, at: Date, reason: String }, { _id: false }),
    },
    createdBy: Schema.Types.ObjectId,
    version: { type: Number, default: 0 },
  },
  { collection: 'jobs', timestamps: true, versionKey: false },
);
jobSchema.index({ jobNo: 1 }, { unique: true });
jobSchema.index({ companyId: 1, status: 1, 'schedule.startDate': -1 });
jobSchema.index({ status: 1, 'schedule.startDate': 1 });
jobSchema.index({ 'positions._id': 1 });
// One job per accepted quotation, even if acceptance is retried (defence in depth).
jobSchema.index(
  { quotationId: 1 },
  { unique: true, partialFilterExpression: { quotationId: { $type: 'objectId' } } },
);

/** What Quotations hands over when a quotation is accepted (FR-JOB-01). */
export interface JobFromQuotation {
  company: CompanyDoc;
  site: SiteDoc;
  categoryId: Types.ObjectId;
  title: string;
  description?: string;
  quotation: {
    id: Types.ObjectId;
    quotationNo: string;
    schedule: QuotationSchedule;
    paymentTerms: PaymentTerms;
    lines: Array<{
      skillId: Types.ObjectId;
      description: string;
      headcount: number;
      unit: PositionDoc['billUnit'];
      ratePaise: number;
      payRatePaise?: number;
    }>;
  };
  minExperienceBySkill: Map<string, number>;
}

/* ================================================================ service */

@Injectable()
export class JobsService {
  constructor(
    @InjectModel(JOB_MODEL) private readonly jobs: Model<JobDoc>,
    private readonly companies: CompaniesService,
    private readonly catalog: CatalogService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
    private readonly sequences: SequenceService,
    private readonly config: BusinessConfigService,
    private readonly txn: TransactionRunner,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------- views */

  async toViews(docs: JobDoc[], opts: { admin: boolean }): Promise<JobView[]> {
    if (docs.length === 0) return [];
    const { categories, skills } = await this.catalog.nameLookups();
    const names = await this.companies.namesByIds(docs.map((d) => d.companyId));
    const sites = await this.companies.sitesByIds(docs.map((d) => d.siteId));
    return docs.map((d) => {
      const site = sites.get(d.siteId.toHexString());
      const totals = d.positions.reduce(
        (a, p) => ({
          required: a.required + p.required,
          held: a.held + p.held,
          confirmed: a.confirmed + p.confirmed,
        }),
        { required: 0, held: 0, confirmed: 0 },
      );
      return {
        id: d._id.toHexString(),
        jobNo: d.jobNo,
        companyId: d.companyId.toHexString(),
        companyName: names.get(d.companyId.toHexString()) ?? '',
        siteId: d.siteId.toHexString(),
        siteName: site?.name ?? '',
        ...(site ? { siteCity: site.address.city } : {}),
        categoryId: d.categoryId.toHexString(),
        categoryName: categories.get(d.categoryId.toHexString()) ?? '',
        ...(d.quotationId
          ? { quotationId: d.quotationId.toHexString(), quotationNo: d.quotationNo ?? '' }
          : {}),
        title: d.title,
        ...(d.description ? { description: d.description } : {}),
        ...(d.instructions ? { instructions: d.instructions } : {}),
        schedule: d.schedule,
        positions: d.positions.map((p) => ({
          id: p._id.toHexString(),
          skillId: p.skillId.toHexString(),
          skillName: skills.get(p.skillId.toHexString())?.name ?? '',
          title: p.title,
          minExperienceYears: p.minExperienceYears,
          requiredCertDocTypeCodes: p.requiredCertDocTypeCodes,
          shift: { startMin: p.shift.startMin, endMin: p.shift.endMin },
          required: p.required,
          held: p.held,
          confirmed: p.confirmed,
          available: p.available,
          billRatePaise: p.billRatePaise,
          billUnit: p.billUnit,
          ...(opts.admin && p.payRatePaise !== undefined ? { payRatePaise: p.payRatePaise } : {}),
          showPayRate: p.showPayRate,
          allowPartialAvailability: p.allowPartialAvailability,
        })),
        billingBasis: d.billingBasis,
        status: d.status,
        ...(opts.admin
          ? {
              statusHistory: d.statusHistory.map((h) => ({
                from: h.from,
                to: h.to,
                at: h.at.toISOString(),
                ...(h.by ? { by: h.by.toHexString() } : {}),
                ...(h.reason ? { reason: h.reason } : {}),
              })),
            }
          : {}),
        ...(d.cancellation
          ? { cancellation: { at: d.cancellation.at.toISOString(), reason: d.cancellation.reason } }
          : {}),
        totals,
        createdAt: d.createdAt.toISOString(),
        version: d.version,
      };
    });
  }

  async toView(doc: JobDoc, admin: boolean): Promise<JobView> {
    const [view] = await this.toViews([doc], { admin });
    return view as JobView;
  }

  async getDoc(id: string | Types.ObjectId, session?: ClientSession): Promise<JobDoc> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.jobs.findById(id, undefined, { session }).lean<JobDoc>().exec()
      : null;
    if (!doc) throw new NotFoundError('Job', String(id));
    return doc;
  }

  /* ---------------------------------------------------------------- creation (FR-JOB-01/02) */

  /**
   * Creates the job of an accepted quotation inside the acceptance transaction, so a quotation is
   * never accepted without its job (DATABASE §13). The job opens immediately (SRS §6.1 stage 1).
   */
  async createFromQuotation(
    data: JobFromQuotation,
    actor: AuditActor,
    session: ClientSession,
  ): Promise<JobDoc> {
    const q = data.quotation;
    const positions = q.lines.map((l) =>
      newPosition({
        skillId: l.skillId.toHexString(),
        title: l.description,
        minExperienceYears: data.minExperienceBySkill.get(l.skillId.toHexString()) ?? 0,
        requiredCertDocTypeCodes: [],
        shift: q.schedule.shift,
        required: l.headcount,
        billRatePaise: l.ratePaise,
        billUnit: l.unit,
        ...(l.payRatePaise !== undefined ? { payRatePaise: l.payRatePaise } : {}),
        showPayRate: false,
        allowPartialAvailability: false,
      }),
    );
    return this.insert(
      {
        companyId: data.company._id,
        siteId: data.site._id,
        categoryId: data.categoryId,
        quotationId: q.id,
        quotationNo: q.quotationNo,
        title: data.title,
        ...(data.description ? { description: data.description } : {}),
        schedule: {
          startDate: q.schedule.startDate,
          endDate: q.schedule.endDate,
          weekdays: q.schedule.weekdays,
          excludedDates: [],
          timezone: data.site.timezone,
        },
        positions,
        billingBasis: q.paymentTerms.milestones.length > 0 ? 'MILESTONE' : 'ATTENDANCE',
        status: 'OPEN',
      },
      actor,
      session,
    );
  }

  private async insert(
    data: Omit<JobDoc, '_id' | 'jobNo' | 'statusHistory' | 'version' | 'createdAt'>,
    actor: AuditActor,
    session: ClientSession,
  ): Promise<JobDoc> {
    const prefix = await this.config.get('job.prefix');
    const jobNo = await this.sequences.formatted('job', prefix, 6, session);
    const [doc] = await this.jobs.create(
      [
        {
          ...data,
          jobNo,
          statusHistory: [
            {
              from: 'NEW',
              to: data.status,
              at: new Date(),
              ...(actor.userId ? { by: new Types.ObjectId(actor.userId) } : {}),
            },
          ],
          ...(actor.userId ? { createdBy: new Types.ObjectId(actor.userId) } : {}),
        },
      ],
      { session },
    );
    const job = (doc as unknown as { toObject(): JobDoc }).toObject();
    const jobId = job._id.toHexString();
    await this.outbox.add(
      {
        type: 'job.created',
        aggregateType: 'Job',
        aggregateId: jobId,
        payload: { jobId, jobNo, companyId: data.companyId.toHexString(), status: data.status },
      },
      session,
    );
    if (data.status === 'OPEN') await this.notifyCompany(job, 'job.created', {}, session);
    await this.audit.record(
      {
        actor,
        action: 'job.create',
        entityType: 'Job',
        entityId: jobId,
        after: { jobNo, status: data.status, quotationId: data.quotationId?.toHexString() },
        context: {},
      },
      session,
    );
    return job;
  }

  async createManual(
    input: z.infer<typeof jobCreateSchema>,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<JobDoc> {
    const company = await this.companies.requireActive(input.companyId);
    await this.companies.requireActiveSite(company._id, input.siteId);
    await this.catalog.assertCategoriesExist([input.categoryId]);
    await this.catalog.assertActiveSkills(
      input.positions.map((p) => p.skillId),
      'positions',
    );
    if (input.positions.some((p) => p.id))
      throw new DomainError('VALIDATION_FAILED', 'New positions must not carry an id.', [
        { path: 'positions' },
      ]);
    const actor = actorFromUser(user);
    const job = await this.txn.run((session) =>
      this.insert(
        {
          companyId: company._id,
          siteId: new Types.ObjectId(input.siteId),
          categoryId: new Types.ObjectId(input.categoryId),
          title: input.title,
          ...(input.description ? { description: input.description } : {}),
          ...(input.instructions ? { instructions: input.instructions } : {}),
          schedule: input.schedule,
          positions: input.positions.map(newPosition),
          billingBasis: input.billingBasis,
          status: 'DRAFT',
        },
        actor,
        session,
      ),
    );
    await this.audit.record({
      actor,
      action: 'job.create_manual',
      entityType: 'Job',
      entityId: job._id.toHexString(),
      context: ctx,
    });
    return job;
  }

  /* ---------------------------------------------------------------- lists */

  async adminList(q: z.infer<typeof jobListQuerySchema>): Promise<{ items: JobView[]; meta: PageMeta }> {
    const filter: FilterQuery<JobDoc> = {};
    if (q.status) filter.status = q.status;
    if (q.companyId) filter.companyId = new Types.ObjectId(q.companyId);
    if (q.categoryId) filter.categoryId = new Types.ObjectId(q.categoryId);
    // Jobs overlapping [from, to].
    if (q.to) filter['schedule.startDate'] = { $lte: q.to };
    if (q.from) filter['schedule.endDate'] = { $gte: q.from };
    if (q.q) filter.$or = [{ jobNo: containsText(q.q) }, { title: containsText(q.q) }];
    const { docs, meta } = await findPage(this.jobs, filter, q);
    return { items: await this.toViews(docs, { admin: true }), meta };
  }

  private companyFilter(user: AuthUser): FilterQuery<JobDoc> {
    const scope = requireCompanyScope(user);
    return { companyId: new Types.ObjectId(scope.companyId), ...siteFilterOf(scope) };
  }

  async listForCompany(
    user: AuthUser,
    q: z.infer<typeof companyJobListQuerySchema>,
  ): Promise<{ items: JobView[]; meta: PageMeta }> {
    const filter = this.companyFilter(user);
    // Drafts are internal until an admin opens them.
    filter.status = q.status ?? { $ne: 'DRAFT' };
    const { docs, meta } = await findPage(this.jobs, filter, q);
    return { items: await this.toViews(docs, { admin: false }), meta };
  }

  async getForCompany(user: AuthUser, id: string): Promise<JobDoc> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.jobs
          .findOne({ _id: id, status: { $ne: 'DRAFT' }, ...this.companyFilter(user) })
          .lean<JobDoc>()
          .exec()
      : null;
    if (!doc) throw new NotFoundError('Job', id);
    return doc;
  }

  /* ---------------------------------------------------------------- state machine (FR-JOB-03/06) */

  async changeStatus(
    id: string,
    action: 'open' | 'hold' | 'resume' | 'cancel' | 'complete',
    reason: string | undefined,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<JobDoc> {
    return this.txn.run(async (session) => {
      const job = await this.getDoc(id, session);
      let to: JobStatus;
      switch (action) {
        case 'open':
          to = 'OPEN';
          if (job.status !== 'DRAFT')
            throw new DomainError('INVALID_STATE_TRANSITION', 'Only draft jobs can be opened.');
          await this.companies.requireActive(job.companyId, session);
          break;
        case 'hold':
          to = 'ON_HOLD';
          break;
        case 'resume':
          if (job.status !== 'ON_HOLD')
            throw new DomainError('INVALID_STATE_TRANSITION', 'Only jobs on hold can be resumed.');
          to = resumeTargetOf(job.statusHistory);
          break;
        case 'cancel':
          to = 'CANCELLED';
          break;
        case 'complete':
          to = 'COMPLETED';
          if (job.schedule.endDate > todayIn(job.schedule.timezone))
            throw new DomainError(
              'INVALID_STATE_TRANSITION',
              'A job can be completed only after its end date.',
            );
          break;
      }
      assertJobTransition(job.status, to);
      const now = new Date();
      const by = new Types.ObjectId(user.id);
      const updated = await this.jobs
        .findOneAndUpdate(
          { _id: job._id, status: job.status, version: job.version },
          {
            $set: {
              status: to,
              ...(to === 'CANCELLED' ? { cancellation: { by, at: now, reason: reason ?? '' } } : {}),
            },
            $push: { statusHistory: { from: job.status, to, by, at: now, ...(reason ? { reason } : {}) } },
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean<JobDoc>()
        .exec();
      if (!updated)
        throw new DomainError(
          'CONCURRENT_MODIFICATION',
          'The job changed at the same time. Reload and retry.',
        );
      // Invitations, proposals and assignments (Phase 5) react to these events (FR-JOB-06).
      await this.outbox.add(
        {
          type: `job.${to === 'CANCELLED' ? 'cancelled' : to === 'ON_HOLD' ? 'put_on_hold' : 'status_changed'}`,
          aggregateType: 'Job',
          aggregateId: id,
          payload: { jobId: id, from: job.status, to, reason: reason ?? null },
        },
        session,
      );
      if (to === 'CANCELLED' || to === 'ON_HOLD' || action === 'open')
        await this.notifyCompany(
          updated,
          to === 'CANCELLED' ? 'job.cancelled' : to === 'ON_HOLD' ? 'job.on_hold' : 'job.created',
          { reason: reason ?? '' },
          session,
        );
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: `job.${action}`,
          entityType: 'Job',
          entityId: id,
          before: { status: job.status },
          after: { status: to },
          ...(reason ? { reason } : {}),
          context: ctx,
        },
        session,
      );
      return updated;
    });
  }

  /* ---------------------------------------------------------------- edit (FR-JOB-05) */

  async update(
    id: string,
    input: z.infer<typeof jobUpdateSchema>,
    expectedVersion: number | undefined,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<{ job: JobDoc; impact: JobUpdateResult['impact'] }> {
    const job = await this.getDoc(id);
    if (!LIVE_JOB_STATUSES.includes(job.status))
      throw new DomainError('INVALID_STATE_TRANSITION', 'Completed or cancelled jobs cannot be edited.');
    if (expectedVersion !== undefined && expectedVersion !== job.version)
      throw new DomainError('VERSION_MISMATCH', 'This job was changed by someone else. Reload and retry.');
    if (input.positions)
      await this.catalog.assertActiveSkills(
        input.positions.map((p) => p.skillId),
        'positions',
      );
    const scheduleChanged =
      !!input.schedule &&
      JSON.stringify(normaliseSchedule(input.schedule)) !== JSON.stringify(normaliseSchedule(job.schedule));
    const { positions, impact } = planJobEdit(job.positions, input.positions, scheduleChanged);
    const status = staffingStatusAfterEdit(job.status, positions);

    const set: Record<string, unknown> = { positions };
    if (input.title !== undefined) set.title = input.title;
    if (input.description !== undefined) set.description = input.description;
    if (input.instructions !== undefined) set.instructions = input.instructions;
    if (input.schedule) set.schedule = input.schedule;
    if (status !== job.status) set.status = status;

    const result = await this.txn.run(async (session) => {
      // Guard: no allocation moved held/confirmed counts since we read the job (Phase 5 reserves
      // places with conditional $inc on positions, which does not bump `version`).
      const filter: FilterQuery<JobDoc> = { _id: job._id, version: job.version };
      if (job.positions.length > 0)
        filter.positions = {
          $all: job.positions.map((p) => ({
            $elemMatch: { _id: p._id, held: p.held, confirmed: p.confirmed },
          })),
        };
      const updated = await this.jobs
        .findOneAndUpdate(
          filter,
          {
            $set: set,
            $inc: { version: 1 },
            ...(status !== job.status
              ? {
                  $push: {
                    statusHistory: {
                      from: job.status,
                      to: status,
                      by: new Types.ObjectId(user.id),
                      at: new Date(),
                      reason: 'Headcount changed',
                    },
                  },
                }
              : {}),
          },
          { new: true, session },
        )
        .lean<JobDoc>()
        .exec();
      if (!updated)
        throw new DomainError(
          'CONCURRENT_MODIFICATION',
          'Allocations on this job changed while you were editing. Reload and retry.',
        );
      if (impact.length > 0 || input.schedule || input.positions)
        await this.outbox.add(
          {
            type: 'job.updated',
            aggregateType: 'Job',
            aggregateId: id,
            payload: { jobId: id, impact: impact as unknown as object[] },
          },
          session,
        );
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'job.update',
          entityType: 'Job',
          entityId: id,
          before: {
            schedule: job.schedule,
            positions: job.positions.map((p) => ({ id: p._id.toHexString(), required: p.required })),
          },
          after: { fields: Object.keys(input), impact },
          context: ctx,
        },
        session,
      );
      return updated;
    });
    return { job: result, impact };
  }

  private async notifyCompany(
    job: JobDoc,
    eventType: string,
    data: Record<string, string>,
    session: ClientSession,
  ): Promise<void> {
    const admins = await this.companies.adminUserIds(job.companyId.toHexString());
    await this.notifications.request(
      {
        eventType,
        priority: eventType === 'job.cancelled' ? 'CRITICAL' : 'NORMAL',
        recipients: admins.map((userId) => ({ userId })),
        data: { jobNo: job.jobNo, title: job.title, id: job._id.toHexString(), ...data },
      },
      session,
    );
  }
}

function normaliseSchedule(s: JobSchedule): object {
  return {
    startDate: s.startDate,
    endDate: s.endDate,
    weekdays: [...s.weekdays].sort(),
    excludedDates: [...(s.excludedDates ?? [])].sort(),
    timezone: s.timezone,
  };
}

/* ================================================================ controllers */

class JobCreateDto extends createZodDto(jobCreateSchema) {}
class JobUpdateDto extends createZodDto(jobUpdateSchema) {}
class ReasonDto extends createZodDto(jobReasonSchema) {}
class AdminListDto extends createZodDto(jobListQuerySchema) {}
class CompanyListDto extends createZodDto(companyJobListQuerySchema) {}

@ApiTags('Jobs (admin)')
@ApiBearerAuth()
@PlatformOnly()
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  @RequirePermissions('job.read')
  @ApiZodQuery(AdminListDto)
  async list(@Query() q: AdminListDto): Promise<PagedResult<JobView>> {
    const { items, meta } = await this.jobs.adminList(q);
    return new PagedResult(items, meta);
  }

  @Post()
  @RequirePermissions('job.manage')
  @ApiZodBody(JobCreateDto)
  async create(
    @Body() dto: JobCreateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<JobView> {
    return this.jobs.toView(await this.jobs.createManual(dto, user, ctx), true);
  }

  @Get(':id')
  @RequirePermissions('job.read')
  async get(@Param('id') id: string): Promise<JobView> {
    return this.jobs.toView(await this.jobs.getDoc(id), true);
  }

  @Patch(':id')
  @RequirePermissions('job.manage')
  @ApiZodBody(JobUpdateDto)
  async update(
    @Param('id') id: string,
    @Body() dto: JobUpdateDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<JobUpdateResult> {
    const { job, impact } = await this.jobs.update(id, dto, parseIfMatch(ifMatch), user, ctx);
    return { job: await this.jobs.toView(job, true), impact };
  }

  @Post(':id/open')
  @HttpCode(200)
  @RequirePermissions('job.manage')
  async open(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<JobView> {
    return this.jobs.toView(await this.jobs.changeStatus(id, 'open', undefined, user, ctx), true);
  }

  @Post(':id/hold')
  @HttpCode(200)
  @RequirePermissions('job.manage')
  @ApiZodBody(ReasonDto)
  async hold(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<JobView> {
    return this.jobs.toView(await this.jobs.changeStatus(id, 'hold', dto.reason, user, ctx), true);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermissions('job.manage')
  async resume(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<JobView> {
    return this.jobs.toView(await this.jobs.changeStatus(id, 'resume', undefined, user, ctx), true);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('job.manage')
  @ApiZodBody(ReasonDto)
  async cancel(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<JobView> {
    return this.jobs.toView(await this.jobs.changeStatus(id, 'cancel', dto.reason, user, ctx), true);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermissions('job.manage')
  async complete(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<JobView> {
    return this.jobs.toView(await this.jobs.changeStatus(id, 'complete', undefined, user, ctx), true);
  }
}

@ApiTags('Jobs')
@ApiBearerAuth()
@Controller('jobs')
export class CompanyJobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  @RequirePermissions('job.read')
  @ApiZodQuery(CompanyListDto)
  async list(@Query() q: CompanyListDto, @CurrentUser() user: AuthUser): Promise<PagedResult<JobView>> {
    const { items, meta } = await this.jobs.listForCompany(user, q);
    return new PagedResult(items, meta);
  }

  @Get(':id')
  @RequirePermissions('job.read')
  async get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<JobView> {
    return this.jobs.toView(await this.jobs.getForCompany(user, id), false);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([{ name: JOB_MODEL, schema: jobSchema }]),
    CatalogModule,
    CompaniesModule,
    NotificationsModule,
  ],
  controllers: [AdminJobsController, CompanyJobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
