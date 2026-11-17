import {
  Body,
  Controller,
  Delete,
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
  addVendorAdminSchema,
  bankDetailsSchema,
  normaliseIdNumber,
  PROVIDER_STATUSES,
  providerListQuerySchema,
  providerStatusChangeSchema,
  vendorCreateSchema,
  vendorUpdateSchema,
  WORKER_STATUSES,
  workerCreateSchema,
  workerListQuerySchema,
  workerUpdateSchema,
  workerVerifySchema,
  type Address,
  type AvailabilityInput,
  type BankDetailsInput,
  type IdType,
  type PageMeta,
  type Proficiency,
  type ProviderStatus,
  type VendorCreateInput,
  type VendorUpdateInput,
  type VendorView,
  type WorkerCreateInput,
  type WorkerStatus,
  type WorkerUpdateInput,
  type WorkerView,
} from '@skillconnect/contracts';
import { actorFromUser, AuditService, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, RequirePermissions } from '../../core/auth/decorators';
import { vendorIdsOf } from '../../core/auth/guards';
import { FieldCrypto, type EncryptedValue } from '../../core/crypto/field-crypto';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { ReqContext } from '../../core/http/request-context';
import { PagedResult } from '../../core/http/response-envelope.interceptor';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';
import { CatalogModule, CatalogService } from '../catalog/catalog.module';
import { DocumentsModule, DocumentsService } from '../documents/documents.module';
import { PersonsModule, PersonsService } from '../persons/persons.module';
import { RolesService } from '../users/roles.service';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

/* ================================================================ schemas (DATABASE §5) */

export const VENDOR_MODEL = 'Vendor';
export const WORKER_MODEL = 'VendorWorker';

type GeoPoint = { type: 'Point'; coordinates: [number, number] };
const enc = new Schema<EncryptedValue>({ ct: String, iv: String, tag: String, kv: Number }, { _id: false });

export interface VendorDoc {
  _id: Types.ObjectId;
  legalName: string;
  tradeName?: string;
  entityType: VendorView['entityType'];
  panEnc: EncryptedValue;
  panHash: string;
  panLast4: string;
  gstin?: string;
  registeredAddress: Address;
  operatingLocations: Array<{ label: string; point: GeoPoint; radiusKm: number }>;
  categoryIds: Types.ObjectId[];
  contacts: VendorView['contacts'];
  bank?: { accountEnc: EncryptedValue; accountLast4: string; ifsc: string; holderName: string };
  status: ProviderStatus;
  /** From the registration plan snapshot; null = unlimited; undefined = no plan chosen yet. */
  workerCap?: number | null;
  activeWorkerCount: number;
  eligibility: { isMatchable: boolean };
  performance: { score: number; ratingAvg: number; ratingCount: number };
  statusReason?: string;
  createdBy: Types.ObjectId;
  approvedAt?: Date;
  version: number;
  createdAt: Date;
}

interface WorkerSkill {
  skillId: Types.ObjectId;
  proficiency: Proficiency;
  years: number;
  verification: 'PENDING' | 'VERIFIED' | 'REJECTED';
}

export interface WorkerDoc {
  _id: Types.ObjectId;
  vendorId: Types.ObjectId;
  personId?: Types.ObjectId;
  fullName: string;
  mobile?: string;
  identity: { idType: IdType; idHash: string; idLast4: string };
  experienceYears: number;
  skills: WorkerSkill[];
  baseLocation: GeoPoint;
  availability: AvailabilityInput;
  status: WorkerStatus;
  eligibility: { isMatchable: boolean; verifiedSkillIds: Types.ObjectId[] };
  review?: { decision: string; comment?: string; at: Date; by: string };
  version: number;
  createdAt: Date;
}

const pointSchema = new Schema(
  { type: { type: String, enum: ['Point'] }, coordinates: [Number] },
  { _id: false },
);

const vendorSchema = new Schema<VendorDoc>(
  {
    legalName: { type: String, required: true },
    tradeName: String,
    entityType: { type: String, required: true },
    panEnc: { type: enc, required: true },
    panHash: { type: String, required: true },
    panLast4: { type: String, required: true },
    gstin: String,
    registeredAddress: { type: Schema.Types.Mixed, required: true },
    operatingLocations: {
      type: [new Schema({ label: String, point: pointSchema, radiusKm: Number }, { _id: false })],
      default: [],
    },
    categoryIds: { type: [Schema.Types.ObjectId], default: [] },
    contacts: { type: [Schema.Types.Mixed] as never, default: [] },
    bank: {
      type: new Schema(
        { accountEnc: enc, accountLast4: String, ifsc: String, holderName: String },
        { _id: false },
      ),
    },
    status: { type: String, enum: PROVIDER_STATUSES, required: true, default: 'DRAFT' },
    workerCap: { type: Number },
    activeWorkerCount: { type: Number, required: true, default: 0 },
    eligibility: { isMatchable: { type: Boolean, default: false } },
    performance: {
      score: { type: Number, default: 0 },
      ratingAvg: { type: Number, default: 0 },
      ratingCount: { type: Number, default: 0 },
    },
    statusReason: String,
    createdBy: { type: Schema.Types.ObjectId, required: true },
    approvedAt: Date,
    version: { type: Number, default: 0 },
  },
  { collection: 'vendors', timestamps: true, versionKey: false },
);
vendorSchema.index({ panHash: 1 }, { unique: true });
vendorSchema.index({ gstin: 1 }, { unique: true, partialFilterExpression: { gstin: { $type: 'string' } } });
vendorSchema.index({ 'operatingLocations.point': '2dsphere' });
vendorSchema.index({ status: 1, createdAt: -1 });

const workerSchema = new Schema<WorkerDoc>(
  {
    vendorId: { type: Schema.Types.ObjectId, required: true },
    personId: Schema.Types.ObjectId,
    fullName: { type: String, required: true },
    mobile: String,
    identity: {
      type: new Schema({ idType: String, idHash: String, idLast4: String }, { _id: false }),
      required: true,
    },
    experienceYears: { type: Number, required: true },
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
    baseLocation: { type: pointSchema, required: true },
    availability: { type: Schema.Types.Mixed, default: () => ({ weekly: [], blockedDates: [] }) },
    status: { type: String, enum: WORKER_STATUSES, required: true, default: 'PENDING_VERIFICATION' },
    eligibility: {
      isMatchable: { type: Boolean, default: false },
      verifiedSkillIds: { type: [Schema.Types.ObjectId], default: [] },
    },
    review: { type: new Schema({ decision: String, comment: String, at: Date, by: String }, { _id: false }) },
    version: { type: Number, default: 0 },
  },
  { collection: 'vendor_workers', timestamps: true, versionKey: false },
);
workerSchema.index({ vendorId: 1, status: 1 });
workerSchema.index(
  { personId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['PENDING_VERIFICATION', 'ACTIVE'] } } },
);
workerSchema.index({ baseLocation: '2dsphere' });
workerSchema.index({ vendorId: 1, 'eligibility.isMatchable': 1, 'eligibility.verifiedSkillIds': 1 });
workerSchema.index({ status: 1, createdAt: 1 });

/* ================================================================ helpers */

const EDITABLE: ProviderStatus[] = ['DRAFT', 'PENDING_PAYMENT', 'CHANGES_REQUESTED', 'APPROVED'];
const ROSTER: WorkerStatus[] = ['PENDING_VERIFICATION', 'ACTIVE'];

export function vendorGaps(v: VendorDoc, gstinRequired = false): string[] {
  const gaps: string[] = [];
  if (v.operatingLocations.length === 0) gaps.push('Operating locations');
  if (v.categoryIds.length === 0) gaps.push('Service categories');
  if (v.contacts.length === 0) gaps.push('Contact person');
  if (gstinRequired && !v.gstin) gaps.push('GSTIN');
  return gaps;
}

function workerEligibility(w: Pick<WorkerDoc, 'status' | 'skills'>): WorkerDoc['eligibility'] {
  const verifiedSkillIds = w.skills.filter((s) => s.verification === 'VERIFIED').map((s) => s.skillId);
  return { isMatchable: w.status === 'ACTIVE' && verifiedSkillIds.length > 0, verifiedSkillIds };
}

function toPoint(l: { lat: number; lng: number }): GeoPoint {
  return { type: 'Point', coordinates: [l.lng, l.lat] };
}

/* ================================================================ vendor service */

@Injectable()
export class VendorsService implements OnModuleInit {
  constructor(
    @InjectModel(VENDOR_MODEL) private readonly vendors: Model<VendorDoc>,
    @InjectModel(WORKER_MODEL) private readonly workers: Model<WorkerDoc>,
    private readonly roles: RolesService,
    private readonly users: UsersService,
    private readonly catalog: CatalogService,
    private readonly documents: DocumentsService,
    private readonly crypto: FieldCrypto,
    private readonly txn: TransactionRunner,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.documents.registerOwner('VENDOR', {
      isOwner: async (user, ownerId) => vendorIdsOf(user).includes(ownerId),
    });
  }

  toView(v: VendorDoc): VendorView {
    const gaps = vendorGaps(v);
    return {
      id: v._id.toHexString(),
      legalName: v.legalName,
      ...(v.tradeName ? { tradeName: v.tradeName } : {}),
      entityType: v.entityType,
      panLast4: v.panLast4,
      ...(v.gstin ? { gstin: v.gstin } : {}),
      registeredAddress: v.registeredAddress,
      categoryIds: v.categoryIds.map((c) => c.toHexString()),
      operatingLocations: v.operatingLocations.map((l) => ({
        label: l.label,
        lng: l.point.coordinates[0],
        lat: l.point.coordinates[1],
        radiusKm: l.radiusKm,
      })),
      contacts: v.contacts,
      ...(v.bank
        ? { bank: { accountLast4: v.bank.accountLast4, ifsc: v.bank.ifsc, holderName: v.bank.holderName } }
        : {}),
      status: v.status,
      workerCap: v.workerCap ?? null,
      activeWorkerCount: v.activeWorkerCount,
      completion: { percent: Math.round(((4 - gaps.length) / 4) * 100), missing: gaps },
      isMatchable: v.eligibility.isMatchable,
      createdAt: v.createdAt.toISOString(),
    };
  }

  vendorIdOf(user: AuthUser): string {
    const [id] = vendorIdsOf(user);
    if (!id || user.userType !== 'VENDOR')
      throw new DomainError('PROVIDER_PROFILE_MISSING', 'Create your vendor profile first.');
    return id;
  }

  async getById(id: string, session?: ClientSession): Promise<VendorDoc> {
    const v = Types.ObjectId.isValid(id)
      ? await this.vendors.findById(id, undefined, { session }).lean<VendorDoc>().exec()
      : null;
    if (!v) throw new NotFoundError('Vendor', id);
    return v;
  }

  async getMine(user: AuthUser): Promise<VendorDoc> {
    return this.getById(this.vendorIdOf(user));
  }

  /** Creates the vendor and makes the creator its first Vendor Admin, atomically. */
  async create(user: AuthUser, input: VendorCreateInput, ctx: AuditContext): Promise<VendorDoc> {
    if (user.userType !== 'VENDOR')
      throw new DomainError('FORBIDDEN', 'Only vendor accounts can create a vendor profile.');
    if (vendorIdsOf(user).length > 0)
      throw new DomainError('PROVIDER_PROFILE_EXISTS', 'You already manage a vendor.');
    const pan = normaliseIdNumber(input.pan);
    try {
      return await this.txn.run(async (session) => {
        const [doc] = await this.vendors.create(
          [
            {
              legalName: input.legalName,
              ...(input.tradeName ? { tradeName: input.tradeName } : {}),
              entityType: input.entityType,
              panEnc: this.crypto.encrypt(pan),
              panHash: this.crypto.hash(pan, 'VENDOR_PAN'),
              panLast4: pan.slice(-4),
              ...(input.gstin ? { gstin: input.gstin } : {}),
              registeredAddress: input.registeredAddress,
              status: 'DRAFT',
              createdBy: new Types.ObjectId(user.id),
            },
          ],
          { session },
        );
        const vendor = (doc as unknown as { toObject(): VendorDoc }).toObject();
        await this.roles.grant(
          user.id,
          { roleCode: 'VENDOR_ADMIN', scope: { type: 'VENDOR', vendorId: vendor._id.toHexString() } },
          actorFromUser(user),
          ctx,
          session,
        );
        await this.audit.record(
          {
            actor: actorFromUser(user),
            action: 'vendor.create',
            entityType: 'Vendor',
            entityId: vendor._id.toHexString(),
            after: { legalName: input.legalName },
            context: ctx,
          },
          session,
        );
        return vendor;
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new DomainError(
          'PROVIDER_PROFILE_EXISTS',
          'A vendor with this PAN or GSTIN is already registered.',
          [{ field: 'pan' }],
        );
      }
      throw err;
    }
  }

  async update(user: AuthUser, input: VendorUpdateInput, ctx: AuditContext): Promise<VendorDoc> {
    const v = await this.getMine(user);
    if (!EDITABLE.includes(v.status))
      throw new DomainError(
        'STATE_CONFLICT',
        v.status === 'PENDING_VERIFICATION'
          ? 'Your profile is being reviewed and cannot be changed right now.'
          : 'This profile can no longer be changed.',
      );
    if (input.categoryIds) await this.catalog.assertCategoriesExist(input.categoryIds);
    const set: Record<string, unknown> = { ...input };
    if (input.categoryIds) set.categoryIds = input.categoryIds.map((c) => new Types.ObjectId(c));
    if (input.operatingLocations)
      set.operatingLocations = input.operatingLocations.map((l) => ({
        label: l.label,
        point: toPoint(l),
        radiusKm: l.radiusKm,
      }));
    try {
      const updated = await this.vendors
        .findOneAndUpdate(
          { _id: v._id, status: { $in: EDITABLE } },
          { $set: set, $inc: { version: 1 } },
          { new: true },
        )
        .lean<VendorDoc>()
        .exec();
      if (!updated)
        throw new DomainError('STATE_CONFLICT', 'Your profile changed status. Reload and try again.');
      await this.audit.record({
        actor: actorFromUser(user),
        action: 'vendor.update',
        entityType: 'Vendor',
        entityId: v._id.toHexString(),
        after: { fields: Object.keys(input) },
        context: ctx,
      });
      return updated;
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new DomainError('STATE_CONFLICT', 'This GSTIN is already registered to another vendor.', [
          { field: 'gstin' },
        ]);
      throw err;
    }
  }

  async setBank(user: AuthUser, bank: BankDetailsInput, ctx: AuditContext): Promise<VendorDoc> {
    const v = await this.getMine(user);
    const updated = await this.vendors
      .findByIdAndUpdate(
        v._id,
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
      .lean<VendorDoc>()
      .exec();
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'vendor.bank_update',
      entityType: 'Vendor',
      entityId: v._id.toHexString(),
      context: ctx,
    });
    return updated as VendorDoc;
  }

  /** Adds another Vendor Admin by mobile: the person must already have a vendor account (FR-VEN-02). */
  async addAdmin(
    user: AuthUser,
    mobile: string,
    ctx: AuditContext,
  ): Promise<{ userId: string; name: string }> {
    const vendorId = this.vendorIdOf(user);
    const target = await this.users.findByMobile(mobile);
    if (!target || target.userType !== 'VENDOR') {
      throw new DomainError(
        'NOT_FOUND',
        'No vendor account uses this mobile number. Ask them to sign up as a vendor first.',
      );
    }
    const existing = await this.roles.activeAssignmentsFor(target._id);
    if (
      existing.some(
        (a) => a.scope.type === 'VENDOR' && a.scope.vendorId && !a.scope.vendorId.equals(vendorId),
      )
    ) {
      throw new DomainError('STATE_CONFLICT', 'This person already manages another vendor.');
    }
    await this.roles.grant(
      target._id.toHexString(),
      { roleCode: 'VENDOR_ADMIN', scope: { type: 'VENDOR', vendorId } },
      actorFromUser(user),
      ctx,
    );
    return { userId: target._id.toHexString(), name: target.name };
  }

  /* ------------------------------------------------------------------ used by Registrations */

  async transition(
    id: Types.ObjectId,
    from: ProviderStatus[],
    to: ProviderStatus,
    session: ClientSession,
    extra: Record<string, unknown> = {},
  ): Promise<VendorDoc> {
    const v = await this.vendors.findOne({ _id: id }, undefined, { session }).lean<VendorDoc>().exec();
    if (!v || !from.includes(v.status))
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `The vendor cannot move from ${v?.status ?? 'unknown'} to ${to}.`,
      );
    const hasActiveWorker = !!(await this.workers
      .exists({ vendorId: id, status: 'ACTIVE' })
      .session(session));
    const updated = await this.vendors
      .findOneAndUpdate(
        { _id: id, status: v.status, version: v.version },
        {
          $set: { status: to, 'eligibility.isMatchable': to === 'APPROVED' && hasActiveWorker, ...extra },
          $inc: { version: 1 },
        },
        { new: true, session },
      )
      .lean<VendorDoc>()
      .exec();
    if (!updated) throw new DomainError('STATE_CONFLICT', 'The vendor was changed at the same time. Retry.');
    return updated;
  }

  /** Applies the plan's worker cap. Lowering it below the current roster is refused. */
  async setWorkerCap(id: Types.ObjectId, cap: number | null, session: ClientSession): Promise<void> {
    const filter: FilterQuery<VendorDoc> = { _id: id };
    if (cap !== null) filter.activeWorkerCount = { $lte: cap };
    const res = await this.vendors.updateOne(filter, { $set: { workerCap: cap } }, { session });
    if (res.matchedCount === 0)
      throw new DomainError(
        'WORKER_CAP_REACHED',
        'You have more workers than this plan allows. Choose a larger plan.',
      );
  }

  async refreshEligibility(vendorId: Types.ObjectId, session?: ClientSession): Promise<void> {
    const v = await this.vendors.findById(vendorId, { status: 1 }, { session }).lean<VendorDoc>().exec();
    if (!v) return;
    const hasActive = !!(await this.workers.exists({ vendorId, status: 'ACTIVE' }).session(session ?? null));
    await this.vendors.updateOne(
      { _id: vendorId },
      { $set: { 'eligibility.isMatchable': v.status === 'APPROVED' && hasActive } },
      { session },
    );
  }

  async list(q: {
    page: number;
    pageSize: number;
    status?: ProviderStatus;
    q?: string;
  }): Promise<{ items: VendorView[]; meta: PageMeta }> {
    const filter: FilterQuery<VendorDoc> = {};
    if (q.status) filter.status = q.status;
    if (q.q) filter.legalName = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [docs, total] = await Promise.all([
      this.vendors
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<VendorDoc[]>()
        .exec(),
      this.vendors.countDocuments(filter),
    ]);
    return { items: docs.map((d) => this.toView(d)), meta: { page: q.page, pageSize: q.pageSize, total } };
  }

  async setSuspended(
    id: string,
    suspend: boolean,
    reason: string,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<VendorView> {
    const v = await this.getById(id);
    const from: ProviderStatus = suspend ? 'APPROVED' : 'SUSPENDED';
    if (v.status !== from)
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `Only ${from.toLowerCase()} vendors can be ${suspend ? 'suspended' : 'reinstated'}.`,
      );
    const updated = await this.txn.run((session) =>
      this.transition(v._id, [from], suspend ? 'SUSPENDED' : 'APPROVED', session, { statusReason: reason }),
    );
    await this.audit.record({
      actor: actorFromUser(user),
      action: suspend ? 'vendor.suspend' : 'vendor.reinstate',
      entityType: 'Vendor',
      entityId: id,
      reason,
      context: ctx,
    });
    return this.toView(updated);
  }
}

/* ================================================================ workers service */

/**
 * Vendor workers (SRS §4.3). Workers are covered by the vendor's registration up to the plan's
 * worker cap (conditional increment, so concurrent adds can never exceed it) and each worker
 * claims a unique person identity (BR-PRV-01).
 */
@Injectable()
export class WorkersService implements OnModuleInit {
  constructor(
    @InjectModel(WORKER_MODEL) private readonly workers: Model<WorkerDoc>,
    @InjectModel(VENDOR_MODEL) private readonly vendors: Model<VendorDoc>,
    private readonly vendorsService: VendorsService,
    private readonly persons: PersonsService,
    private readonly catalog: CatalogService,
    private readonly documents: DocumentsService,
    private readonly txn: TransactionRunner,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.documents.registerOwner('VENDOR_WORKER', {
      isOwner: async (user, ownerId) => {
        const vendorIds = vendorIdsOf(user);
        if (vendorIds.length === 0) return false;
        return !!(await this.workers.exists({
          _id: ownerId,
          vendorId: { $in: vendorIds.map((v) => new Types.ObjectId(v)) },
        }));
      },
    });
  }

  async toView(w: WorkerDoc): Promise<WorkerView> {
    const skills = await this.catalog.activeSkillsByIds(w.skills.map((s) => s.skillId.toHexString()));
    const names = new Map(skills.map((s) => [s.id, s.name]));
    return {
      id: w._id.toHexString(),
      vendorId: w.vendorId.toHexString(),
      fullName: w.fullName,
      ...(w.mobile ? { mobile: w.mobile } : {}),
      identity: { idType: w.identity.idType, idLast4: w.identity.idLast4 },
      experienceYears: w.experienceYears,
      skills: w.skills.map((s) => ({
        skillId: s.skillId.toHexString(),
        skillName: names.get(s.skillId.toHexString()),
        proficiency: s.proficiency,
        years: s.years,
        verification: s.verification,
      })),
      baseLocation: { lng: w.baseLocation.coordinates[0], lat: w.baseLocation.coordinates[1] },
      status: w.status,
      isMatchable: w.eligibility.isMatchable,
      ...(w.review
        ? {
            review: {
              decision: w.review.decision,
              ...(w.review.comment ? { comment: w.review.comment } : {}),
              at: w.review.at.toISOString(),
            },
          }
        : {}),
      createdAt: w.createdAt.toISOString(),
    };
  }

  private async getOwn(user: AuthUser, id: string): Promise<WorkerDoc> {
    const vendorId = this.vendorsService.vendorIdOf(user);
    const w = Types.ObjectId.isValid(id)
      ? await this.workers.findOne({ _id: id, vendorId }).lean<WorkerDoc>().exec()
      : null;
    if (!w) throw new NotFoundError('Worker', id);
    return w;
  }

  /** Reserves a roster slot under the plan's cap, atomically. */
  private async reserveSlot(vendorId: Types.ObjectId, session: ClientSession): Promise<void> {
    const v = await this.vendors
      .findById(vendorId, { workerCap: 1, status: 1 }, { session })
      .lean<VendorDoc>()
      .exec();
    if (!v) throw new NotFoundError('Vendor', vendorId.toHexString());
    if (v.workerCap === undefined)
      throw new DomainError(
        'REGISTRATION_PLAN_REQUIRED',
        'Choose a registration plan before adding workers.',
      );
    if (['REJECTED', 'SUSPENDED', 'DEACTIVATED'].includes(v.status))
      throw new DomainError('STATE_CONFLICT', 'Workers cannot be added to this vendor.');
    const res = await this.vendors.updateOne(
      { _id: vendorId, $or: [{ workerCap: null }, { $expr: { $lt: ['$activeWorkerCount', '$workerCap'] } }] },
      { $inc: { activeWorkerCount: 1 } },
      { session },
    );
    if (res.modifiedCount !== 1)
      throw new DomainError(
        'WORKER_CAP_REACHED',
        'Your plan’s worker limit is reached. Upgrade your plan or deactivate a worker.',
      );
  }

  private async releaseSlot(vendorId: Types.ObjectId, session: ClientSession): Promise<void> {
    await this.vendors.updateOne(
      { _id: vendorId, activeWorkerCount: { $gt: 0 } },
      { $inc: { activeWorkerCount: -1 } },
      { session },
    );
  }

  async create(user: AuthUser, input: WorkerCreateInput, ctx: AuditContext): Promise<WorkerView> {
    const vendorId = new Types.ObjectId(this.vendorsService.vendorIdOf(user));
    const skills = await this.catalog.activeSkillsByIds(input.skills.map((s) => s.skillId));
    if (skills.length !== new Set(input.skills.map((s) => s.skillId)).size)
      throw new DomainError('VALIDATION_FAILED', 'One or more skills are not available.', [
        { field: 'skills' },
      ]);
    const raw = normaliseIdNumber(input.identity.idNumber);
    const idHash = this.persons.hashId(input.identity.idType, raw);
    const _id = new Types.ObjectId();
    try {
      const worker = await this.txn.run(async (session) => {
        await this.reserveSlot(vendorId, session);
        const person = await this.persons.claim(
          {
            fullName: input.fullName,
            idType: input.identity.idType,
            idHash,
            idLast4: raw.slice(-4),
            ...(input.mobile ? { mobile: input.mobile } : {}),
            role: { type: 'VENDOR_WORKER', refId: _id.toHexString(), vendorId: vendorId.toHexString() },
          },
          session,
        );
        const [doc] = await this.workers.create(
          [
            {
              _id,
              vendorId,
              personId: person._id,
              fullName: input.fullName,
              ...(input.mobile ? { mobile: input.mobile } : {}),
              identity: { idType: input.identity.idType, idHash, idLast4: raw.slice(-4) },
              experienceYears: input.experienceYears,
              skills: input.skills.map((s) => ({
                skillId: new Types.ObjectId(s.skillId),
                proficiency: s.proficiency,
                years: s.years,
                verification: 'PENDING',
              })),
              baseLocation: toPoint(input.baseLocation),
              status: 'PENDING_VERIFICATION',
            },
          ],
          { session },
        );
        await this.audit.record(
          {
            actor: actorFromUser(user),
            action: 'worker.create',
            entityType: 'VendorWorker',
            entityId: _id.toHexString(),
            after: { vendorId: vendorId.toHexString(), fullName: input.fullName },
            context: ctx,
          },
          session,
        );
        return (doc as unknown as { toObject(): WorkerDoc }).toObject();
      });
      return this.toView(worker);
    } catch (err) {
      await this.persons
        .recordConflict(err, {
          type: 'VENDOR_WORKER',
          vendorId: vendorId.toHexString(),
          refId: _id.toHexString(),
          name: input.fullName,
        })
        .catch(() => undefined);
      throw err;
    }
  }

  async list(
    vendorId: Types.ObjectId,
    q: { page: number; pageSize: number; status?: WorkerStatus },
  ): Promise<{ items: WorkerView[]; meta: PageMeta }> {
    const filter: FilterQuery<WorkerDoc> = { vendorId };
    if (q.status) filter.status = q.status;
    const [docs, total] = await Promise.all([
      this.workers
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<WorkerDoc[]>()
        .exec(),
      this.workers.countDocuments(filter),
    ]);
    return {
      items: await Promise.all(docs.map((d) => this.toView(d))),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  }

  async listMine(user: AuthUser, q: { page: number; pageSize: number; status?: WorkerStatus }) {
    return this.list(new Types.ObjectId(this.vendorsService.vendorIdOf(user)), q);
  }

  async getMine(user: AuthUser, id: string): Promise<WorkerView> {
    return this.toView(await this.getOwn(user, id));
  }

  async update(user: AuthUser, id: string, input: WorkerUpdateInput, ctx: AuditContext): Promise<WorkerView> {
    const w = await this.getOwn(user, id);
    if (!ROSTER.includes(w.status))
      throw new DomainError('STATE_CONFLICT', 'Reactivate this worker before editing.');
    const set: Record<string, unknown> = {};
    if (input.fullName) set.fullName = input.fullName;
    if (input.experienceYears !== undefined) set.experienceYears = input.experienceYears;
    if (input.baseLocation) set.baseLocation = toPoint(input.baseLocation);
    if (input.availability) set.availability = input.availability;
    if (input.mobile !== undefined && input.mobile !== w.mobile)
      throw new DomainError(
        'VALIDATION_FAILED',
        'A worker’s mobile number cannot be changed. Deactivate and re-add the worker instead.',
        [{ field: 'mobile' }],
      );
    if (input.skills) {
      const known = await this.catalog.activeSkillsByIds(input.skills.map((s) => s.skillId));
      if (known.length !== new Set(input.skills.map((s) => s.skillId)).size)
        throw new DomainError('VALIDATION_FAILED', 'One or more skills are not available.', [
          { field: 'skills' },
        ]);
      const prev = new Map(w.skills.map((s) => [s.skillId.toHexString(), s]));
      const next = input.skills.map((s) => {
        const p = prev.get(s.skillId);
        const same = p && p.proficiency === s.proficiency && p.years === s.years;
        return {
          skillId: new Types.ObjectId(s.skillId),
          proficiency: s.proficiency,
          years: s.years,
          verification: same ? p.verification : ('PENDING' as const),
        };
      });
      set.skills = next;
      set.eligibility = workerEligibility({ status: w.status, skills: next });
    }
    const updated = await this.workers
      .findOneAndUpdate(
        { _id: w._id, status: { $in: ROSTER } },
        { $set: set, $inc: { version: 1 } },
        { new: true },
      )
      .lean<WorkerDoc>()
      .exec();
    if (!updated) throw new DomainError('STATE_CONFLICT', 'The worker changed. Reload and try again.');
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'worker.update',
      entityType: 'VendorWorker',
      entityId: id,
      after: { fields: Object.keys(set) },
      context: ctx,
    });
    return this.toView(updated);
  }

  /** Removes a worker from the roster, frees the plan slot and the person identity. */
  async deactivate(user: AuthUser, id: string, ctx: AuditContext): Promise<WorkerView> {
    const w = await this.getOwn(user, id);
    // Future-assignment checks (FR-VWK-06) are added with the Assignments module in Phase 5.
    const updated = await this.txn.run(async (session) => {
      const doc = await this.workers
        .findOneAndUpdate(
          { _id: w._id, status: { $in: ROSTER } },
          {
            $set: { status: 'INACTIVE', eligibility: { isMatchable: false, verifiedSkillIds: [] } },
            $unset: { personId: 1 },
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean<WorkerDoc>()
        .exec();
      if (!doc) throw new DomainError('INVALID_STATE_TRANSITION', 'This worker is not on the active roster.');
      await this.releaseSlot(w.vendorId, session);
      if (w.personId) await this.persons.release(w.personId, session);
      await this.vendorsService.refreshEligibility(w.vendorId, session);
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'worker.deactivate',
          entityType: 'VendorWorker',
          entityId: id,
          context: ctx,
        },
        session,
      );
      return doc;
    });
    return this.toView(updated);
  }

  /** Verification Officer decision (FR-VWK-03). Rejection frees the slot and the identity. */
  async verify(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    comment: string | undefined,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<WorkerView> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Worker', id);
    const updated = await this.txn.run(async (session) => {
      const w = await this.workers
        .findOne({ _id: id, status: 'PENDING_VERIFICATION' }, undefined, { session })
        .lean<WorkerDoc>()
        .exec();
      if (!w)
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          'Only workers awaiting verification can be reviewed.',
        );
      const review = { decision, ...(comment ? { comment } : {}), at: new Date(), by: user.id };
      let doc: WorkerDoc | null;
      if (decision === 'APPROVED') {
        const skills = w.skills.map((s) => ({ ...s, verification: 'VERIFIED' as const }));
        doc = await this.workers
          .findOneAndUpdate(
            { _id: w._id, status: 'PENDING_VERIFICATION' },
            {
              $set: {
                status: 'ACTIVE',
                skills,
                eligibility: workerEligibility({ status: 'ACTIVE', skills }),
                review,
              },
              $inc: { version: 1 },
            },
            { new: true, session },
          )
          .lean<WorkerDoc>()
          .exec();
      } else {
        doc = await this.workers
          .findOneAndUpdate(
            { _id: w._id, status: 'PENDING_VERIFICATION' },
            { $set: { status: 'REJECTED', review }, $unset: { personId: 1 }, $inc: { version: 1 } },
            { new: true, session },
          )
          .lean<WorkerDoc>()
          .exec();
        await this.releaseSlot(w.vendorId, session);
        if (w.personId) await this.persons.release(w.personId, session);
      }
      if (!doc) throw new DomainError('STATE_CONFLICT', 'The worker changed. Reload and retry.');
      await this.vendorsService.refreshEligibility(w.vendorId, session);
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: `worker.${decision.toLowerCase()}`,
          entityType: 'VendorWorker',
          entityId: id,
          reason: comment,
          context: ctx,
        },
        session,
      );
      return doc;
    });
    return this.toView(updated);
  }

  async pendingVerification(
    page: number,
    pageSize: number,
  ): Promise<{ items: WorkerView[]; meta: PageMeta }> {
    const filter = { status: 'PENDING_VERIFICATION' as const };
    const [docs, total] = await Promise.all([
      this.workers
        .find(filter)
        .sort({ createdAt: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean<WorkerDoc[]>()
        .exec(),
      this.workers.countDocuments(filter),
    ]);
    return { items: await Promise.all(docs.map((d) => this.toView(d))), meta: { page, pageSize, total } };
  }
}

/* ================================================================ controllers */

class VendorCreateDto extends createZodDto(vendorCreateSchema) {}
class VendorUpdateDto extends createZodDto(vendorUpdateSchema) {}
class BankDto extends createZodDto(bankDetailsSchema) {}
class AddAdminDto extends createZodDto(addVendorAdminSchema) {}
class WorkerCreateDto extends createZodDto(workerCreateSchema) {}
class WorkerUpdateDto extends createZodDto(workerUpdateSchema) {}
class WorkerListDto extends createZodDto(workerListQuerySchema) {}
class WorkerVerifyDto extends createZodDto(workerVerifySchema) {}
class ProviderListDto extends createZodDto(providerListQuerySchema) {}
class StatusDto extends createZodDto(providerStatusChangeSchema) {}

@ApiTags('Vendors')
@ApiBearerAuth()
@Controller('vendors')
export class VendorsController {
  constructor(
    private readonly vendors: VendorsService,
    private readonly workers: WorkersService,
  ) {}

  /** Any signed-in vendor-type account may create its vendor (it has no vendor role yet). */
  @Post()
  @ApiZodBody(VendorCreateDto)
  async create(
    @Body() dto: VendorCreateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<VendorView> {
    return this.vendors.toView(await this.vendors.create(user, dto, ctx));
  }

  @Get('me')
  @RequirePermissions('vendor.manage')
  async me(@CurrentUser() user: AuthUser): Promise<VendorView> {
    return this.vendors.toView(await this.vendors.getMine(user));
  }

  @Patch('me')
  @RequirePermissions('vendor.manage')
  @ApiZodBody(VendorUpdateDto)
  async update(
    @Body() dto: VendorUpdateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<VendorView> {
    return this.vendors.toView(await this.vendors.update(user, dto, ctx));
  }

  @Put('me/bank')
  @RequirePermissions('vendor.manage')
  @ApiZodBody(BankDto)
  async bank(
    @Body() dto: BankDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<VendorView> {
    return this.vendors.toView(await this.vendors.setBank(user, dto, ctx));
  }

  @Post('me/users')
  @RequirePermissions('vendor.manage')
  @ApiZodBody(AddAdminDto)
  addAdmin(@Body() dto: AddAdminDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: AuditContext) {
    return this.vendors.addAdmin(user, dto.mobile, ctx);
  }

  @Get('me/workers')
  @RequirePermissions('worker.manage')
  @ApiZodQuery(WorkerListDto)
  async workersList(
    @Query() q: WorkerListDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PagedResult<WorkerView>> {
    const { items, meta } = await this.workers.listMine(user, q);
    return new PagedResult(items, meta);
  }

  @Post('me/workers')
  @RequirePermissions('worker.manage')
  @ApiZodBody(WorkerCreateDto)
  createWorker(
    @Body() dto: WorkerCreateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<WorkerView> {
    return this.workers.create(user, dto, ctx);
  }

  @Get('me/workers/:id')
  @RequirePermissions('worker.manage')
  worker(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<WorkerView> {
    return this.workers.getMine(user, id);
  }

  @Patch('me/workers/:id')
  @RequirePermissions('worker.manage')
  @ApiZodBody(WorkerUpdateDto)
  updateWorker(
    @Param('id') id: string,
    @Body() dto: WorkerUpdateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<WorkerView> {
    return this.workers.update(user, id, dto, ctx);
  }

  @Delete('me/workers/:id')
  @RequirePermissions('worker.manage')
  deactivateWorker(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<WorkerView> {
    return this.workers.deactivate(user, id, ctx);
  }
}

@ApiTags('Vendors (admin)')
@ApiBearerAuth()
@Controller('admin')
export class AdminVendorsController {
  constructor(
    private readonly vendors: VendorsService,
    private readonly workers: WorkersService,
  ) {}

  @Get('vendors')
  @RequirePermissions('provider.read')
  @ApiZodQuery(ProviderListDto)
  async list(@Query() q: ProviderListDto): Promise<PagedResult<VendorView>> {
    const { items, meta } = await this.vendors.list(q);
    return new PagedResult(items, meta);
  }

  @Get('vendors/:id')
  @RequirePermissions('provider.read')
  async get(@Param('id') id: string): Promise<VendorView> {
    return this.vendors.toView(await this.vendors.getById(id));
  }

  @Get('vendors/:id/workers')
  @RequirePermissions('provider.read')
  @ApiZodQuery(WorkerListDto)
  async vendorWorkers(@Param('id') id: string, @Query() q: WorkerListDto): Promise<PagedResult<WorkerView>> {
    const v = await this.vendors.getById(id);
    const { items, meta } = await this.workers.list(v._id, q);
    return new PagedResult(items, meta);
  }

  @Post('vendors/:id/suspend')
  @HttpCode(200)
  @RequirePermissions('provider.suspend')
  @ApiZodBody(StatusDto)
  suspend(
    @Param('id') id: string,
    @Body() dto: StatusDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<VendorView> {
    return this.vendors.setSuspended(id, true, dto.reason, user, ctx);
  }

  @Post('vendors/:id/reinstate')
  @HttpCode(200)
  @RequirePermissions('provider.suspend')
  @ApiZodBody(StatusDto)
  reinstate(
    @Param('id') id: string,
    @Body() dto: StatusDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<VendorView> {
    return this.vendors.setSuspended(id, false, dto.reason, user, ctx);
  }

  @Get('vendor-workers/pending')
  @RequirePermissions('registration.verify')
  async pending(@Query() q: WorkerListDto): Promise<PagedResult<WorkerView>> {
    const { items, meta } = await this.workers.pendingVerification(q.page, q.pageSize);
    return new PagedResult(items, meta);
  }

  @Post('vendor-workers/:id/verify')
  @HttpCode(200)
  @RequirePermissions('registration.verify')
  @ApiZodBody(WorkerVerifyDto)
  verify(
    @Param('id') id: string,
    @Body() dto: WorkerVerifyDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<WorkerView> {
    return this.workers.verify(id, dto.decision, dto.comment, user, ctx);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VENDOR_MODEL, schema: vendorSchema },
      { name: WORKER_MODEL, schema: workerSchema },
    ]),
    UsersModule,
    CatalogModule,
    DocumentsModule,
    PersonsModule,
  ],
  controllers: [VendorsController, AdminVendorsController],
  providers: [VendorsService, WorkersService],
  exports: [VendorsService, WorkersService],
})
export class VendorsModule {}
