import {
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Logger,
  Module,
  Param,
  Patch,
  Post,
  Query,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Schema, Types, type ClientSession, type Model } from 'mongoose';
import { z } from 'zod';
import {
  applyBasisPoints,
  PROVIDER_TYPES,
  registrationPlanSchema,
  type PlanSnapshot,
  type ProviderType,
  type RegistrationPlanInput,
  type RegistrationPlanView,
} from '@bijliwala/contracts';
import { actorFromUser, AuditService, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, Public, RequirePermissions } from '../../core/auth/decorators';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { parseIfMatch } from '../../core/http/if-match';
import { ReqContext } from '../../core/http/request-context';
import { ApiZodBody, createZodDto } from '../../core/http/zod';

export const PLAN_MODEL = 'RegistrationPlan';

interface PlanDoc extends RegistrationPlanInput {
  _id: Types.ObjectId;
  version: number;
}

const planSchema = new Schema<PlanDoc>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    providerType: { type: String, enum: PROVIDER_TYPES, required: true },
    description: String,
    feePaise: { type: Number, required: true, min: 0 },
    gstRateBp: { type: Number, required: true, min: 0 },
    sacCode: { type: String, required: true },
    features: { type: [String], default: [] },
    maxWorkers: { type: Number, default: null },
    mandatoryDocTypeCodes: { type: [String], default: [] },
    gstinRequired: { type: Boolean, default: false },
    offlinePaymentAllowed: { type: Boolean, default: true },
    refundPolicy: {
      type: new Schema({ onRejection: String, partialPct: Number }, { _id: false }),
      required: true,
    },
    isActive: { type: Boolean, default: true },
    displayOrder: { type: Number, default: 0 },
    version: { type: Number, default: 0 },
  },
  { collection: 'registration_plans', timestamps: true, versionKey: false },
);
planSchema.index({ code: 1 }, { unique: true });
planSchema.index({ providerType: 1, isActive: 1, displayOrder: 1 });

export function toPlanView(p: PlanDoc): RegistrationPlanView {
  const { _id, ...rest } = p;
  const taxPaise = applyBasisPoints(p.feePaise, p.gstRateBp);
  return {
    ...(rest as RegistrationPlanInput),
    id: _id.toHexString(),
    maxWorkers: p.maxWorkers ?? null,
    taxPaise,
    totalPaise: p.feePaise + taxPaise,
    version: p.version,
  };
}

/** Snapshot copied onto a registration: later price changes never affect it (FR-PLN-03). */
export function snapshotOf(p: RegistrationPlanView): PlanSnapshot {
  return {
    planId: p.id,
    code: p.code,
    name: p.name,
    feePaise: p.feePaise,
    gstRateBp: p.gstRateBp,
    taxPaise: p.taxPaise,
    totalPaise: p.totalPaise,
    maxWorkers: p.maxWorkers,
    mandatoryDocTypeCodes: p.mandatoryDocTypeCodes,
    offlinePaymentAllowed: p.offlinePaymentAllowed,
    gstinRequired: p.gstinRequired,
    refundPolicy: {
      onRejection: p.refundPolicy.onRejection,
      ...(p.refundPolicy.partialPct ? { partialPct: p.refundPolicy.partialPct } : {}),
    },
  };
}

/** Starter plans so a fresh install is usable. Prices are editable by admins and never hard-coded in flows. */
const DEFAULT_PLANS: RegistrationPlanInput[] = [
  {
    code: 'PRO_STANDARD',
    name: 'Professional',
    providerType: 'PROFESSIONAL',
    description: 'One-time registration for individual professionals.',
    feePaise: 99_900,
    gstRateBp: 1800,
    sacCode: '998519',
    features: [
      'Verified profile badge',
      'Job invitations matched to your skills',
      'Attendance and work history',
    ],
    maxWorkers: null,
    mandatoryDocTypeCodes: ['PHOTO', 'AADHAAR_MASKED', 'PAN_CARD'],
    gstinRequired: false,
    offlinePaymentAllowed: true,
    refundPolicy: { onRejection: 'FULL' },
    isActive: true,
    displayOrder: 0,
  },
  {
    code: 'VENDOR_BASIC',
    name: 'Vendor Basic',
    providerType: 'VENDOR',
    description: 'For contractors with a small team.',
    feePaise: 499_900,
    gstRateBp: 1800,
    sacCode: '998519',
    features: ['Up to 25 workers', 'Respond to jobs with team capacity', 'Proxy attendance for workers'],
    maxWorkers: 25,
    mandatoryDocTypeCodes: ['PAN_CARD', 'GST_CERT', 'CANCELLED_CHEQUE'],
    gstinRequired: true,
    offlinePaymentAllowed: true,
    refundPolicy: { onRejection: 'PARTIAL', partialPct: 80 },
    isActive: true,
    displayOrder: 0,
  },
  {
    code: 'VENDOR_ENTERPRISE',
    name: 'Vendor Enterprise',
    providerType: 'VENDOR',
    description: 'For agencies with large workforces.',
    feePaise: 1_499_900,
    gstRateBp: 1800,
    sacCode: '998519',
    features: ['Unlimited workers', 'Priority verification', 'Proxy attendance for workers'],
    maxWorkers: null,
    mandatoryDocTypeCodes: ['PAN_CARD', 'GST_CERT', 'CANCELLED_CHEQUE', 'TRADE_LICENCE'],
    gstinRequired: true,
    offlinePaymentAllowed: true,
    refundPolicy: { onRejection: 'PARTIAL', partialPct: 80 },
    isActive: true,
    displayOrder: 1,
  },
];

@Injectable()
export class PlansService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @InjectModel(PLAN_MODEL) private readonly plans: Model<PlanDoc>,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || (await this.plans.estimatedDocumentCount()) > 0) return;
    await this.plans.insertMany(DEFAULT_PLANS).catch((err: { code?: number }) => {
      if (err.code !== 11000) throw err;
    });
    this.logger.log('Seeded starter registration plans');
  }

  async list(providerType?: ProviderType, includeInactive = false): Promise<RegistrationPlanView[]> {
    const filter: Record<string, unknown> = {};
    if (providerType) filter.providerType = providerType;
    if (!includeInactive) filter.isActive = true;
    const docs = await this.plans
      .find(filter)
      .sort({ providerType: 1, displayOrder: 1, feePaise: 1 })
      .lean<PlanDoc[]>()
      .exec();
    return docs.map(toPlanView);
  }

  async activeByCode(
    code: string,
    providerType: ProviderType,
    session?: ClientSession,
  ): Promise<RegistrationPlanView> {
    const doc = await this.plans
      .findOne({ code, isActive: true }, undefined, { session })
      .lean<PlanDoc>()
      .exec();
    if (!doc) throw new DomainError('PLAN_INACTIVE', 'This plan is not available.', [{ field: 'planCode' }]);
    if (doc.providerType !== providerType)
      throw new DomainError('PLAN_INACTIVE', 'This plan is for a different kind of provider.', [
        { field: 'planCode' },
      ]);
    return toPlanView(doc);
  }

  async create(
    input: RegistrationPlanInput,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<RegistrationPlanView> {
    try {
      const doc = await this.plans.create({ ...input, version: 0 });
      await this.audit.record({
        actor: actorFromUser(user),
        action: 'plan.create',
        entityType: 'RegistrationPlan',
        entityId: doc._id.toHexString(),
        after: input,
        context: ctx,
      });
      return toPlanView(doc.toObject());
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new DomainError('STATE_CONFLICT', `Plan code ${input.code} already exists.`, [
          { field: 'code' },
        ]);
      throw err;
    }
  }

  async update(
    id: string,
    input: RegistrationPlanInput,
    expectedVersion: number | undefined,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<RegistrationPlanView> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Plan', id);
    const before = await this.plans.findById(id).lean<PlanDoc>().exec();
    if (!before) throw new NotFoundError('Plan', id);
    if (before.code !== input.code || before.providerType !== input.providerType) {
      throw new DomainError('VALIDATION_FAILED', 'The plan code and provider type cannot be changed.');
    }
    const doc = await this.plans
      .findOneAndUpdate(
        { _id: before._id, version: expectedVersion ?? before.version },
        { $set: input, $inc: { version: 1 } },
        { new: true },
      )
      .lean<PlanDoc>()
      .exec();
    if (!doc)
      throw new DomainError('VERSION_MISMATCH', 'This plan was changed by someone else. Reload and retry.');
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'plan.update',
      entityType: 'RegistrationPlan',
      entityId: id,
      before: toPlanView(before),
      after: input,
      context: ctx,
    });
    return toPlanView(doc);
  }
}

class PlanDto extends createZodDto(registrationPlanSchema) {}
class PlanQuery extends createZodDto(
  z.object({ providerType: z.enum(PROVIDER_TYPES).optional() }).strict(),
) {}

@ApiTags('Registration plans')
@Controller()
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Public()
  @Get('public/registration-plans')
  publicList(@Query() q: PlanQuery): Promise<RegistrationPlanView[]> {
    return this.plans.list(q.providerType);
  }

  @ApiBearerAuth()
  @Get('admin/registration-plans')
  @RequirePermissions('plan.manage')
  adminList(): Promise<RegistrationPlanView[]> {
    return this.plans.list(undefined, true);
  }

  @ApiBearerAuth()
  @Post('admin/registration-plans')
  @RequirePermissions('plan.manage')
  @ApiZodBody(PlanDto)
  create(
    @Body() dto: PlanDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationPlanView> {
    return this.plans.create(dto, user, ctx);
  }

  @ApiBearerAuth()
  @Patch('admin/registration-plans/:id')
  @RequirePermissions('plan.manage')
  @ApiZodBody(PlanDto)
  update(
    @Param('id') id: string,
    @Body() dto: PlanDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<RegistrationPlanView> {
    return this.plans.update(id, dto, parseIfMatch(ifMatch), user, ctx);
  }
}

@Module({
  imports: [MongooseModule.forFeature([{ name: PLAN_MODEL, schema: planSchema }])],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
