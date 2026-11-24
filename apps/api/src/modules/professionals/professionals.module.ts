import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Schema, Types, type ClientSession, type FilterQuery, type Model } from 'mongoose';
import {
  availabilitySchema,
  bankDetailsSchema,
  normaliseIdNumber,
  professionalSkillsSchema,
  professionalUpdateSchema,
  PROVIDER_STATUSES,
  providerListQuerySchema,
  providerStatusChangeSchema,
  type Address,
  type AvailabilityInput,
  type BankDetailsInput,
  type IdType,
  type PageMeta,
  type Proficiency,
  type ProfessionalUpdateInput,
  type ProfessionalView,
  type ProviderStatus,
} from '@bijliwala/contracts';
import { actorFromUser, AuditService, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, RequirePermissions } from '../../core/auth/decorators';
import { FieldCrypto, type EncryptedValue } from '../../core/crypto/field-crypto';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { ReqContext } from '../../core/http/request-context';
import { PagedResult } from '../../core/http/response-envelope.interceptor';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';
import { CatalogModule, CatalogService } from '../catalog/catalog.module';
import { DocumentsModule, DocumentsService } from '../documents/documents.module';
import { PersonsModule, PersonsService } from '../persons/persons.module';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

/* ================================================================ schema (DATABASE §5) */

export const PROFESSIONAL_MODEL = 'Professional';

interface SkillEntry {
  skillId: Types.ObjectId;
  proficiency: Proficiency;
  years: number;
  verification: 'PENDING' | 'VERIFIED' | 'REJECTED';
}

export interface ProfessionalDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  personId?: Types.ObjectId;
  fullName: string;
  dob?: string;
  gender?: string;
  address?: Address;
  serviceLocation?: { type: 'Point'; coordinates: [number, number] };
  radiusKm?: number;
  languages: string[];
  experienceYears?: number;
  categoryIds: Types.ObjectId[];
  identity?: { idType: IdType; idHash: string; idLast4: string; idNumberEnc?: EncryptedValue };
  skills: SkillEntry[];
  availability: AvailabilityInput;
  bank?: { accountEnc: EncryptedValue; accountLast4: string; ifsc: string; holderName: string };
  status: ProviderStatus;
  eligibility: { isMatchable: boolean; verifiedSkillIds: Types.ObjectId[] };
  performance: {
    score: number;
    ratingAvg: number;
    ratingCount: number;
    attendanceRate: number;
    noShowCount: number;
  };
  statusReason?: string;
  approvedAt?: Date;
  approvedBy?: string;
  version: number;
  createdAt: Date;
}

const enc = new Schema<EncryptedValue>({ ct: String, iv: String, tag: String, kv: Number }, { _id: false });

const professionalSchema = new Schema<ProfessionalDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    personId: Schema.Types.ObjectId,
    fullName: { type: String, required: true },
    dob: String,
    gender: String,
    address: { type: Schema.Types.Mixed },
    serviceLocation: {
      type: new Schema({ type: { type: String, enum: ['Point'] }, coordinates: [Number] }, { _id: false }),
    },
    radiusKm: Number,
    languages: { type: [String], default: [] },
    experienceYears: Number,
    categoryIds: { type: [Schema.Types.ObjectId], default: [] },
    identity: {
      type: new Schema({ idType: String, idHash: String, idLast4: String, idNumberEnc: enc }, { _id: false }),
    },
    skills: {
      type: [
        new Schema(
          {
            skillId: Schema.Types.ObjectId,
            proficiency: String,
            years: Number,
            verification: { type: String, default: 'PENDING' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    availability: { type: Schema.Types.Mixed, default: () => ({ weekly: [], blockedDates: [] }) },
    bank: {
      type: new Schema(
        { accountEnc: enc, accountLast4: String, ifsc: String, holderName: String },
        { _id: false },
      ),
    },
    status: { type: String, enum: PROVIDER_STATUSES, required: true, default: 'DRAFT' },
    eligibility: {
      isMatchable: { type: Boolean, default: false },
      verifiedSkillIds: { type: [Schema.Types.ObjectId], default: [] },
    },
    performance: {
      score: { type: Number, default: 0 },
      ratingAvg: { type: Number, default: 0 },
      ratingCount: { type: Number, default: 0 },
      attendanceRate: { type: Number, default: 0 },
      noShowCount: { type: Number, default: 0 },
    },
    statusReason: String,
    approvedAt: Date,
    approvedBy: String,
    version: { type: Number, default: 0 },
  },
  { collection: 'professionals', timestamps: true, versionKey: false },
);
professionalSchema.index({ userId: 1 }, { unique: true });
professionalSchema.index(
  { personId: 1 },
  { unique: true, partialFilterExpression: { personId: { $type: 'objectId' } } },
);
professionalSchema.index({ serviceLocation: '2dsphere' });
professionalSchema.index({ status: 1, 'eligibility.isMatchable': 1, 'eligibility.verifiedSkillIds': 1 });
professionalSchema.index({ categoryIds: 1 });
professionalSchema.index({ status: 1, createdAt: -1 });

/* ================================================================ domain helpers */

/** Profile sections required before submission; returns human-readable gaps (FR-PRO-02). */
export function professionalGaps(p: ProfessionalDoc): string[] {
  const gaps: string[] = [];
  if (!p.dob) gaps.push('Date of birth');
  if (!p.address) gaps.push('Address');
  if (!p.serviceLocation || !p.radiusKm) gaps.push('Work location and travel radius');
  if (p.experienceYears === undefined) gaps.push('Years of experience');
  if (!p.identity) gaps.push('Government ID');
  if (p.skills.length === 0) gaps.push('Skills');
  if (p.languages.length === 0) gaps.push('Languages');
  return gaps;
}

const PROFILE_SECTIONS = 7;

/** Fields may be edited in these states; under review the profile is frozen. */
const EDITABLE: ProviderStatus[] = ['DRAFT', 'PENDING_PAYMENT', 'CHANGES_REQUESTED', 'APPROVED'];

export function eligibilityOf(p: Pick<ProfessionalDoc, 'status' | 'skills'>): ProfessionalDoc['eligibility'] {
  const verifiedSkillIds = p.skills.filter((s) => s.verification === 'VERIFIED').map((s) => s.skillId);
  return { isMatchable: p.status === 'APPROVED' && verifiedSkillIds.length > 0, verifiedSkillIds };
}

/* ================================================================ service */

@Injectable()
export class ProfessionalsService implements OnModuleInit {
  constructor(
    @InjectModel(PROFESSIONAL_MODEL) private readonly pros: Model<ProfessionalDoc>,
    private readonly catalog: CatalogService,
    private readonly documents: DocumentsService,
    private readonly persons: PersonsService,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.documents.registerOwner('PROFESSIONAL', {
      isOwner: async (user, ownerId) =>
        user.userType === 'PROFESSIONAL' && !!(await this.pros.exists({ _id: ownerId, userId: user.id })),
    });
  }

  async toView(p: ProfessionalDoc): Promise<ProfessionalView> {
    const skills = await this.catalog.activeSkillsByIds(p.skills.map((s) => s.skillId.toHexString()));
    const names = new Map(skills.map((s) => [s.id, s.name]));
    const gaps = professionalGaps(p);
    return {
      id: p._id.toHexString(),
      userId: p.userId.toHexString(),
      fullName: p.fullName,
      ...(p.dob ? { dob: p.dob } : {}),
      ...(p.gender ? { gender: p.gender } : {}),
      ...(p.address ? { address: p.address } : {}),
      ...(p.serviceLocation
        ? {
            serviceLocation: { lng: p.serviceLocation.coordinates[0], lat: p.serviceLocation.coordinates[1] },
          }
        : {}),
      ...(p.radiusKm ? { radiusKm: p.radiusKm } : {}),
      languages: p.languages,
      ...(p.experienceYears !== undefined ? { experienceYears: p.experienceYears } : {}),
      categoryIds: p.categoryIds.map((c) => c.toHexString()),
      ...(p.identity ? { identity: { idType: p.identity.idType, idLast4: p.identity.idLast4 } } : {}),
      skills: p.skills.map((s) => ({
        skillId: s.skillId.toHexString(),
        skillName: names.get(s.skillId.toHexString()),
        proficiency: s.proficiency,
        years: s.years,
        verification: s.verification,
      })),
      availability: p.availability,
      ...(p.bank
        ? { bank: { accountLast4: p.bank.accountLast4, ifsc: p.bank.ifsc, holderName: p.bank.holderName } }
        : {}),
      status: p.status,
      completion: {
        percent: Math.round(((PROFILE_SECTIONS - gaps.length) / PROFILE_SECTIONS) * 100),
        missing: gaps,
      },
      isMatchable: p.eligibility.isMatchable,
      createdAt: p.createdAt.toISOString(),
    };
  }

  async findByUser(userId: string): Promise<ProfessionalDoc | null> {
    return this.pros
      .findOne({ userId: new Types.ObjectId(userId) })
      .lean<ProfessionalDoc>()
      .exec();
  }

  async getMine(user: AuthUser): Promise<ProfessionalDoc> {
    const p = user.userType === 'PROFESSIONAL' ? await this.findByUser(user.id) : null;
    if (!p) throw new DomainError('PROVIDER_PROFILE_MISSING', 'Create your professional profile first.');
    return p;
  }

  async getById(id: string, session?: ClientSession): Promise<ProfessionalDoc> {
    const p = Types.ObjectId.isValid(id)
      ? await this.pros.findById(id, undefined, { session }).lean<ProfessionalDoc>().exec()
      : null;
    if (!p) throw new NotFoundError('Professional', id);
    return p;
  }

  async createMine(user: AuthUser, fullName: string): Promise<ProfessionalDoc> {
    if (user.userType !== 'PROFESSIONAL')
      throw new DomainError('FORBIDDEN', 'Only professional accounts can create a professional profile.');
    try {
      const doc = await this.pros.create({ userId: new Types.ObjectId(user.id), fullName, status: 'DRAFT' });
      return doc.toObject();
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new DomainError('PROVIDER_PROFILE_EXISTS', 'You already have a professional profile.');
      throw err;
    }
  }

  private assertEditable(p: ProfessionalDoc): void {
    if (!EDITABLE.includes(p.status)) {
      throw new DomainError(
        'STATE_CONFLICT',
        p.status === 'PENDING_VERIFICATION'
          ? 'Your profile is being reviewed and cannot be changed right now.'
          : 'This profile can no longer be changed.',
      );
    }
  }

  async updateMine(
    user: AuthUser,
    input: ProfessionalUpdateInput,
    ctx: AuditContext,
  ): Promise<ProfessionalDoc> {
    const p = await this.getMine(user);
    this.assertEditable(p);
    if (input.categoryIds) await this.catalog.assertCategoriesExist(input.categoryIds);
    const set: Record<string, unknown> = {};
    if (input.fullName) set.fullName = input.fullName;
    if (input.dob) set.dob = input.dob;
    if (input.gender) set.gender = input.gender;
    if (input.address) set.address = input.address;
    if (input.serviceLocation)
      set.serviceLocation = {
        type: 'Point',
        coordinates: [input.serviceLocation.lng, input.serviceLocation.lat],
      };
    if (input.radiusKm !== undefined) set.radiusKm = input.radiusKm;
    if (input.languages) set.languages = input.languages;
    if (input.experienceYears !== undefined) set.experienceYears = input.experienceYears;
    if (input.categoryIds) set.categoryIds = input.categoryIds.map((c) => new Types.ObjectId(c));
    if (input.identity) {
      if (p.personId)
        throw new DomainError(
          'STATE_CONFLICT',
          'Your ID is already linked to your verified identity. Contact support to change it.',
        );
      const raw = normaliseIdNumber(input.identity.idNumber);
      set.identity = {
        idType: input.identity.idType,
        idHash: this.persons.hashId(input.identity.idType, raw),
        idLast4: raw.slice(-4),
        // Full Aadhaar numbers are never stored (FR-DOC-05); other IDs are kept encrypted.
        ...(input.identity.idType === 'AADHAAR' ? {} : { idNumberEnc: this.crypto.encrypt(raw) }),
      };
    }
    const updated = await this.pros
      .findOneAndUpdate(
        { _id: p._id, status: { $in: EDITABLE } },
        { $set: set, $inc: { version: 1 } },
        { new: true },
      )
      .lean<ProfessionalDoc>()
      .exec();
    if (!updated)
      throw new DomainError('STATE_CONFLICT', 'Your profile changed status. Reload and try again.');
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'professional.update',
      entityType: 'Professional',
      entityId: p._id.toHexString(),
      after: { fields: Object.keys(set) },
      context: ctx,
    });
    return updated;
  }

  /** Skills changed after approval go back to PENDING verification (FR-PRO-06); unchanged ones keep theirs. */
  async setSkills(
    user: AuthUser,
    skills: Array<{ skillId: string; proficiency: Proficiency; years: number }>,
  ): Promise<ProfessionalDoc> {
    const p = await this.getMine(user);
    this.assertEditable(p);
    const known = await this.catalog.activeSkillsByIds(skills.map((s) => s.skillId));
    if (known.length !== new Set(skills.map((s) => s.skillId)).size) {
      throw new DomainError('VALIDATION_FAILED', 'One or more skills are not available.', [
        { field: 'skills' },
      ]);
    }
    const previous = new Map(p.skills.map((s) => [s.skillId.toHexString(), s]));
    const next: SkillEntry[] = skills.map((s) => {
      const prev = previous.get(s.skillId);
      const unchanged = prev && prev.proficiency === s.proficiency && prev.years === s.years;
      return {
        skillId: new Types.ObjectId(s.skillId),
        proficiency: s.proficiency,
        years: s.years,
        verification: unchanged ? prev.verification : 'PENDING',
      };
    });
    const updated = await this.pros
      .findOneAndUpdate(
        { _id: p._id, status: { $in: EDITABLE } },
        {
          $set: { skills: next, eligibility: eligibilityOf({ status: p.status, skills: next }) },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<ProfessionalDoc>()
      .exec();
    if (!updated)
      throw new DomainError('STATE_CONFLICT', 'Your profile changed status. Reload and try again.');
    return updated;
  }

  async setAvailability(user: AuthUser, availability: AvailabilityInput): Promise<ProfessionalDoc> {
    const p = await this.getMine(user);
    const updated = await this.pros
      .findByIdAndUpdate(p._id, { $set: { availability }, $inc: { version: 1 } }, { new: true })
      .lean<ProfessionalDoc>()
      .exec();
    return updated as ProfessionalDoc;
  }

  async setBank(user: AuthUser, bank: BankDetailsInput, ctx: AuditContext): Promise<ProfessionalDoc> {
    const p = await this.getMine(user);
    this.assertEditable(p);
    const updated = await this.pros
      .findByIdAndUpdate(
        p._id,
        {
          $set: {
            bank: {
              accountEnc: this.crypto.encrypt(bank.accountNumber),
              accountLast4: bank.accountNumber.slice(-4),
              ifsc: bank.ifsc,
              holderName: bank.holderName,
            },
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<ProfessionalDoc>()
      .exec();
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'professional.bank_update',
      entityType: 'Professional',
      entityId: p._id.toHexString(),
      context: ctx,
    });
    return updated as ProfessionalDoc;
  }

  /* ------------------------------------------------------------------ used by Registrations */

  /** Document types required by the professional's skills (FR-CAT-02). */
  async skillDocTypes(p: ProfessionalDoc): Promise<string[]> {
    const skills = await this.catalog.activeSkillsByIds(p.skills.map((s) => s.skillId.toHexString()));
    return [...new Set(skills.flatMap((s) => s.requiredDocTypeCodes))];
  }

  /** Conditional lifecycle transition (FR-PRO-04). Throws STATE_CONFLICT when the state moved. */
  async transition(
    id: Types.ObjectId,
    from: ProviderStatus[],
    to: ProviderStatus,
    session: ClientSession,
    extra: Record<string, unknown> = {},
  ): Promise<ProfessionalDoc> {
    const p = await this.pros.findOne({ _id: id }, undefined, { session }).lean<ProfessionalDoc>().exec();
    if (!p || !from.includes(p.status))
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `The profile cannot move from ${p?.status ?? 'unknown'} to ${to}.`,
      );
    const skills =
      to === 'APPROVED'
        ? p.skills.map(
            (s) =>
              ({ ...s, verification: s.verification === 'REJECTED' ? 'REJECTED' : 'VERIFIED' }) as SkillEntry,
          )
        : p.skills;
    const updated = await this.pros
      .findOneAndUpdate(
        { _id: id, status: p.status, version: p.version },
        {
          $set: { status: to, skills, eligibility: eligibilityOf({ status: to, skills }), ...extra },
          $inc: { version: 1 },
        },
        { new: true, session },
      )
      .lean<ProfessionalDoc>()
      .exec();
    if (!updated) throw new DomainError('STATE_CONFLICT', 'The profile was changed at the same time. Retry.');
    return updated;
  }

  async linkPerson(id: Types.ObjectId, personId: Types.ObjectId, session: ClientSession): Promise<void> {
    await this.pros.updateOne({ _id: id }, { $set: { personId } }, { session });
  }

  async unlinkPerson(id: Types.ObjectId, session: ClientSession): Promise<Types.ObjectId | undefined> {
    const p = await this.pros
      .findOneAndUpdate({ _id: id }, { $unset: { personId: 1 } }, { session })
      .lean<ProfessionalDoc>()
      .exec();
    return p?.personId;
  }

  /* ------------------------------------------------------------------ admin */

  async list(q: {
    page: number;
    pageSize: number;
    status?: ProviderStatus;
    q?: string;
    skillId?: string;
  }): Promise<{ items: ProfessionalView[]; meta: PageMeta }> {
    const filter: FilterQuery<ProfessionalDoc> = {};
    if (q.status) filter.status = q.status;
    if (q.skillId) filter['skills.skillId'] = new Types.ObjectId(q.skillId);
    if (q.q) filter.fullName = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [docs, total] = await Promise.all([
      this.pros
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<ProfessionalDoc[]>()
        .exec(),
      this.pros.countDocuments(filter),
    ]);
    return {
      items: await Promise.all(docs.map((d) => this.toView(d))),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  }

  async setSuspended(
    id: string,
    suspend: boolean,
    reason: string,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<ProfessionalView> {
    const p = await this.getById(id);
    const from: ProviderStatus = suspend ? 'APPROVED' : 'SUSPENDED';
    const to: ProviderStatus = suspend ? 'SUSPENDED' : 'APPROVED';
    if (p.status !== from)
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `Only ${from.toLowerCase()} professionals can be ${suspend ? 'suspended' : 'reinstated'}.`,
      );
    const updated = await this.pros
      .findOneAndUpdate(
        { _id: p._id, status: from },
        {
          $set: {
            status: to,
            statusReason: reason,
            eligibility: eligibilityOf({ status: to, skills: p.skills }),
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<ProfessionalDoc>()
      .exec();
    if (!updated) throw new DomainError('STATE_CONFLICT', 'The profile changed. Reload and retry.');
    await this.audit.record({
      actor: actorFromUser(user),
      action: suspend ? 'professional.suspend' : 'professional.reinstate',
      entityType: 'Professional',
      entityId: id,
      reason,
      context: ctx,
    });
    return this.toView(updated);
  }
}

/* ================================================================ controllers */

class UpdateDto extends createZodDto(professionalUpdateSchema) {}
class SkillsDto extends createZodDto(professionalSkillsSchema) {}
class AvailabilityDto extends createZodDto(availabilitySchema) {}
class BankDto extends createZodDto(bankDetailsSchema) {}
class ListQueryDto extends createZodDto(providerListQuerySchema) {}
class StatusDto extends createZodDto(providerStatusChangeSchema) {}

@ApiTags('Professionals')
@ApiBearerAuth()
@Controller('professionals/me')
@RequirePermissions('profile.self')
export class MyProfessionalController {
  constructor(
    private readonly pros: ProfessionalsService,
    private readonly users: UsersService,
  ) {}

  @Post()
  async create(@CurrentUser() user: AuthUser): Promise<ProfessionalView> {
    const account = await this.users.getById(user.id);
    return this.pros.toView(await this.pros.createMine(user, account.name));
  }

  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<ProfessionalView> {
    return this.pros.toView(await this.pros.getMine(user));
  }

  @Patch()
  @ApiZodBody(UpdateDto)
  async update(
    @Body() dto: UpdateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<ProfessionalView> {
    return this.pros.toView(await this.pros.updateMine(user, dto, ctx));
  }

  @Put('skills')
  @ApiZodBody(SkillsDto)
  async skills(@Body() dto: SkillsDto, @CurrentUser() user: AuthUser): Promise<ProfessionalView> {
    return this.pros.toView(await this.pros.setSkills(user, dto.skills));
  }

  @Put('availability')
  @ApiZodBody(AvailabilityDto)
  async availability(@Body() dto: AvailabilityDto, @CurrentUser() user: AuthUser): Promise<ProfessionalView> {
    return this.pros.toView(await this.pros.setAvailability(user, dto));
  }

  @Put('bank')
  @ApiZodBody(BankDto)
  async bank(
    @Body() dto: BankDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<ProfessionalView> {
    return this.pros.toView(await this.pros.setBank(user, dto, ctx));
  }
}

@ApiTags('Professionals (admin)')
@ApiBearerAuth()
@Controller('admin/professionals')
export class AdminProfessionalsController {
  constructor(private readonly pros: ProfessionalsService) {}

  @Get()
  @RequirePermissions('provider.read')
  @ApiZodQuery(ListQueryDto)
  async list(@Query() q: ListQueryDto): Promise<PagedResult<ProfessionalView>> {
    const { items, meta } = await this.pros.list(q);
    return new PagedResult(items, meta);
  }

  @Get(':id')
  @RequirePermissions('provider.read')
  async get(@Param('id') id: string): Promise<ProfessionalView> {
    return this.pros.toView(await this.pros.getById(id));
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermissions('provider.suspend')
  @ApiZodBody(StatusDto)
  suspend(
    @Param('id') id: string,
    @Body() dto: StatusDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<ProfessionalView> {
    return this.pros.setSuspended(id, true, dto.reason, user, ctx);
  }

  @Post(':id/reinstate')
  @HttpCode(200)
  @RequirePermissions('provider.suspend')
  @ApiZodBody(StatusDto)
  reinstate(
    @Param('id') id: string,
    @Body() dto: StatusDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<ProfessionalView> {
    return this.pros.setSuspended(id, false, dto.reason, user, ctx);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([{ name: PROFESSIONAL_MODEL, schema: professionalSchema }]),
    CatalogModule,
    DocumentsModule,
    PersonsModule,
    UsersModule,
  ],
  controllers: [MyProfessionalController, AdminProfessionalsController],
  providers: [ProfessionalsService],
  exports: [ProfessionalsService],
})
export class ProfessionalsModule {}
