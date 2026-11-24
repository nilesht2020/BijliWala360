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
import { z } from 'zod';
import {
  blockedProvidersSchema,
  commercialTermsSchema,
  COMPANY_SIZES,
  COMPANY_STATUSES,
  companyCreateSchema,
  companyListQuerySchema,
  companyStatusChangeSchema,
  companyUpdateSchema,
  companyUserInviteSchema,
  DEFAULT_COMMERCIAL_TERMS,
  siteInputSchema,
  siteUpdateSchema,
  type BlockedProvidersInput,
  type CommercialTerms,
  type CompanyCreateInput,
  type CompanyRoleCode,
  type CompanySize,
  type CompanyStatus,
  type CompanyUpdateInput,
  type CompanyUserInviteInput,
  type CompanyUserView,
  type CompanyView,
  type GstAddress,
  type PageMeta,
  type SiteView,
} from '@bijliwala/contracts';
import {
  actorFromUser,
  AuditService,
  type AuditActor,
  type AuditContext,
} from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, PlatformOnly, RequirePermissions } from '../../core/auth/decorators';
import { companyIdsOf } from '../../core/auth/guards';
import { FieldCrypto, type EncryptedValue } from '../../core/crypto/field-crypto';
import { containsText, findPage } from '../../core/database/query';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { ReqContext } from '../../core/http/request-context';
import { PagedResult } from '../../core/http/response-envelope.interceptor';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';
import { DocumentsModule, DocumentsService } from '../documents/documents.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationsService } from '../notifications/notifications.service';
import { RolesService } from '../users/roles.service';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

/* ================================================================ schemas (DATABASE §8) */

export const COMPANY_MODEL = 'Company';
export const SITE_MODEL = 'CompanySite';

type GeoPoint = { type: 'Point'; coordinates: [number, number] };
const enc = new Schema<EncryptedValue>({ ct: String, iv: String, tag: String, kv: Number }, { _id: false });

export interface CompanyDoc {
  _id: Types.ObjectId;
  legalName: string;
  panEnc: EncryptedValue;
  panHash: string;
  panLast4: string;
  gstin?: string;
  industry?: string;
  size?: CompanySize;
  billingAddress: GstAddress;
  primaryContactUserId: Types.ObjectId;
  status: CompanyStatus;
  statusReason?: string;
  commercialTerms: CommercialTerms;
  blockedProviders: Array<{
    type: CompanyView['blockedProviders'][number]['type'];
    id: Types.ObjectId;
    reason?: string;
  }>;
  source: 'SELF' | 'LEAD';
  activatedBy?: Types.ObjectId;
  activatedAt?: Date;
  version: number;
  createdAt: Date;
}

export interface SiteDoc {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  name: string;
  address: GstAddress;
  location: GeoPoint;
  timezone: string;
  contact: { name: string; mobile: string };
  geofenceMeters?: number;
  isActive: boolean;
}

const companySchema = new Schema<CompanyDoc>(
  {
    legalName: { type: String, required: true, trim: true },
    panEnc: { type: enc, required: true },
    panHash: { type: String, required: true },
    panLast4: { type: String, required: true },
    gstin: String,
    industry: String,
    size: { type: String, enum: COMPANY_SIZES },
    billingAddress: { type: Schema.Types.Mixed, required: true },
    primaryContactUserId: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: COMPANY_STATUSES, required: true, default: 'PENDING_VERIFICATION' },
    statusReason: String,
    commercialTerms: {
      type: Schema.Types.Mixed,
      required: true,
      default: () => ({ ...DEFAULT_COMMERCIAL_TERMS }),
    },
    blockedProviders: {
      type: [new Schema({ type: String, id: Schema.Types.ObjectId, reason: String }, { _id: false })],
      default: [],
    },
    source: { type: String, enum: ['SELF', 'LEAD'], default: 'SELF' },
    activatedBy: Schema.Types.ObjectId,
    activatedAt: Date,
    version: { type: Number, default: 0 },
  },
  { collection: 'companies', timestamps: true, versionKey: false },
);
companySchema.index({ panHash: 1 }, { unique: true });
companySchema.index({ gstin: 1 }, { unique: true, partialFilterExpression: { gstin: { $type: 'string' } } });
companySchema.index({ status: 1, createdAt: -1 });
companySchema.index({ legalName: 1 });

const siteSchema = new Schema<SiteDoc>(
  {
    companyId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    address: { type: Schema.Types.Mixed, required: true },
    location: {
      type: new Schema({ type: { type: String, enum: ['Point'] }, coordinates: [Number] }, { _id: false }),
      required: true,
    },
    timezone: { type: String, default: 'Asia/Kolkata' },
    contact: { type: new Schema({ name: String, mobile: String }, { _id: false }), required: true },
    geofenceMeters: Number,
    isActive: { type: Boolean, default: true },
  },
  { collection: 'company_sites', timestamps: true, versionKey: false },
);
siteSchema.index({ companyId: 1, isActive: 1 });
siteSchema.index({ location: '2dsphere' });

/* ================================================================ scope helpers */

/**
 * The company a portal user acts for, and the sites they are limited to (FR-CMP-03).
 * `siteIds` is undefined when any of the user's grants in that company is unrestricted.
 */
export function companyScopeOf(user: AuthUser): { companyId: string; siteIds?: string[] } | null {
  const scopes = user.scopes.flatMap((s) => (s.type === 'COMPANY' ? [s] : []));
  const first = scopes[0];
  if (!first || user.userType !== 'COMPANY') return null;
  const mine = scopes.filter((s) => s.companyId === first.companyId);
  if (mine.some((s) => !s.siteIds?.length)) return { companyId: first.companyId };
  return { companyId: first.companyId, siteIds: [...new Set(mine.flatMap((s) => s.siteIds ?? []))] };
}

export function requireCompanyScope(user: AuthUser): { companyId: string; siteIds?: string[] } {
  const scope = companyScopeOf(user);
  if (!scope) throw new DomainError('COMPANY_PROFILE_MISSING', 'Register your company first.');
  return scope;
}

/** Mongo filter fragment limiting records to the user's sites (no-op for unrestricted users). */
export function siteFilterOf(scope: { siteIds?: string[] }): Record<string, unknown> {
  return scope.siteIds ? { siteId: { $in: scope.siteIds.map((s) => new Types.ObjectId(s)) } } : {};
}

function toPoint(l: { lat: number; lng: number }): GeoPoint {
  return { type: 'Point', coordinates: [l.lng, l.lat] };
}

export function toSiteView(s: SiteDoc): SiteView {
  return {
    id: s._id.toHexString(),
    companyId: s.companyId.toHexString(),
    name: s.name,
    address: s.address,
    location: { lng: s.location.coordinates[0], lat: s.location.coordinates[1] },
    timezone: s.timezone,
    contact: s.contact,
    ...(s.geofenceMeters ? { geofenceMeters: s.geofenceMeters } : {}),
    isActive: s.isActive,
  };
}

const COMPANY_ROLES: readonly CompanyRoleCode[] = ['COMPANY_ADMIN', 'COMPANY_USER'];

/* ================================================================ service */

@Injectable()
export class CompaniesService implements OnModuleInit {
  constructor(
    @InjectModel(COMPANY_MODEL) private readonly companies: Model<CompanyDoc>,
    @InjectModel(SITE_MODEL) private readonly sites: Model<SiteDoc>,
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly documents: DocumentsService,
    private readonly notifications: NotificationsService,
    private readonly crypto: FieldCrypto,
    private readonly txn: TransactionRunner,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.documents.registerOwner('COMPANY', {
      isOwner: async (user, ownerId) => companyIdsOf(user).includes(ownerId),
    });
  }

  /* ---------------------------------------------------------------- views & lookups */

  async toView(c: CompanyDoc): Promise<CompanyView> {
    const [contact, activeSiteCount] = await Promise.all([
      this.users.findById(c.primaryContactUserId.toHexString()),
      this.sites.countDocuments({ companyId: c._id, isActive: true }),
    ]);
    return {
      id: c._id.toHexString(),
      legalName: c.legalName,
      panLast4: c.panLast4,
      ...(c.gstin ? { gstin: c.gstin } : {}),
      ...(c.industry ? { industry: c.industry } : {}),
      ...(c.size ? { size: c.size } : {}),
      billingAddress: c.billingAddress,
      status: c.status,
      ...(c.statusReason ? { statusReason: c.statusReason } : {}),
      commercialTerms: { ...DEFAULT_COMMERCIAL_TERMS, ...c.commercialTerms },
      blockedProviders: c.blockedProviders.map((b) => ({
        type: b.type,
        id: b.id.toHexString(),
        ...(b.reason ? { reason: b.reason } : {}),
      })),
      ...(contact
        ? {
            primaryContact: {
              userId: contact._id.toHexString(),
              name: contact.name,
              ...(contact.mobile ? { mobile: contact.mobile } : {}),
            },
          }
        : {}),
      activeSiteCount,
      ...(c.activatedAt ? { activatedAt: c.activatedAt.toISOString() } : {}),
      createdAt: c.createdAt.toISOString(),
      version: c.version,
    };
  }

  async getById(id: string | Types.ObjectId, session?: ClientSession): Promise<CompanyDoc> {
    const c = Types.ObjectId.isValid(id)
      ? await this.companies.findById(id, undefined, { session }).lean<CompanyDoc>().exec()
      : null;
    if (!c) throw new NotFoundError('Company', String(id));
    return c;
  }

  async getMine(user: AuthUser): Promise<CompanyDoc> {
    return this.getById(requireCompanyScope(user).companyId);
  }

  /** Jobs (and quotation acceptance) need a verified company (FR-CMP-02). */
  async requireActive(id: string | Types.ObjectId, session?: ClientSession): Promise<CompanyDoc> {
    const c = await this.getById(id, session);
    if (c.status !== 'ACTIVE')
      throw new DomainError(
        'COMPANY_NOT_ACTIVE',
        c.status === 'SUSPENDED'
          ? 'This company account is suspended.'
          : 'This company is waiting for verification by Bijli Wala.',
      );
    return c;
  }

  /** Enquiries are allowed while pending, but not for suspended companies. */
  async requireNotSuspended(id: string | Types.ObjectId, session?: ClientSession): Promise<CompanyDoc> {
    const c = await this.getById(id, session);
    if (c.status === 'SUSPENDED')
      throw new DomainError('COMPANY_NOT_ACTIVE', 'This company account is suspended.');
    return c;
  }

  async namesByIds(ids: Types.ObjectId[]): Promise<Map<string, string>> {
    const docs = await this.companies
      .find({ _id: { $in: ids } }, { legalName: 1 })
      .lean<Pick<CompanyDoc, '_id' | 'legalName'>[]>()
      .exec();
    return new Map(docs.map((d) => [d._id.toHexString(), d.legalName]));
  }

  async adminUserIds(companyId: string): Promise<string[]> {
    return this.roles.userIdsInScope('COMPANY_ADMIN', { companyId });
  }

  /* ---------------------------------------------------------------- self-service */

  /** Creates the company and makes the creator its Company Admin and primary contact, atomically. */
  async create(user: AuthUser, input: CompanyCreateInput, ctx: AuditContext): Promise<CompanyDoc> {
    if (user.userType !== 'COMPANY')
      throw new DomainError('FORBIDDEN', 'Only company accounts can register a company.');
    if (companyScopeOf(user))
      throw new DomainError('COMPANY_PROFILE_EXISTS', 'You already belong to a company.');
    return this.txn.run((session) =>
      this.insertCompany(input, user.id, 'SELF', actorFromUser(user), ctx, session),
    );
  }

  /**
   * Lead conversion (FR-ENQ-04): creates the company for the lead's contact. The contact gets a
   * company account (created if needed) and becomes its Company Admin.
   */
  async createForContact(
    input: CompanyCreateInput,
    contact: { name: string; mobile: string; email?: string },
    actor: AuditActor,
    ctx: AuditContext,
    session: ClientSession,
  ): Promise<CompanyDoc> {
    let person = await this.users.findByMobile(contact.mobile, session);
    if (person && person.userType !== 'COMPANY')
      throw new DomainError(
        'COMPANY_USER_CONFLICT',
        'This mobile number belongs to a provider or admin account and cannot own a company.',
        [{ field: 'mobile' }],
      );
    if (person) {
      const grants = await this.roles.activeAssignmentsFor(person._id, session);
      if (grants.some((g) => g.scope.type === 'COMPANY'))
        throw new DomainError(
          'COMPANY_USER_CONFLICT',
          'The lead contact already belongs to a company. Link the enquiry to that company instead.',
        );
    } else {
      person = await this.users.createInvited(
        {
          name: contact.name,
          mobile: contact.mobile,
          userType: 'COMPANY',
          ...(contact.email ? { email: contact.email } : {}),
        },
        session,
      );
    }
    return this.insertCompany(input, person._id.toHexString(), 'LEAD', actor, ctx, session);
  }

  private async insertCompany(
    input: CompanyCreateInput,
    contactUserId: string,
    source: CompanyDoc['source'],
    actor: AuditActor,
    ctx: AuditContext,
    session: ClientSession,
  ): Promise<CompanyDoc> {
    try {
      const [doc] = await this.companies.create(
        [
          {
            legalName: input.legalName,
            panEnc: this.crypto.encrypt(input.pan),
            panHash: this.crypto.hash(input.pan, 'COMPANY_PAN'),
            panLast4: input.pan.slice(-4),
            ...(input.gstin ? { gstin: input.gstin } : {}),
            ...(input.industry ? { industry: input.industry } : {}),
            ...(input.size ? { size: input.size } : {}),
            billingAddress: input.billingAddress,
            primaryContactUserId: new Types.ObjectId(contactUserId),
            status: 'PENDING_VERIFICATION',
            commercialTerms: { ...DEFAULT_COMMERCIAL_TERMS },
            source,
          },
        ],
        { session },
      );
      const company = (doc as unknown as { toObject(): CompanyDoc }).toObject();
      const companyId = company._id.toHexString();
      await this.roles.grant(
        contactUserId,
        { roleCode: 'COMPANY_ADMIN', scope: { type: 'COMPANY', companyId } },
        actor,
        ctx,
        session,
      );
      await this.audit.record(
        {
          actor,
          action: 'company.create',
          entityType: 'Company',
          entityId: companyId,
          after: { legalName: input.legalName, source },
          context: ctx,
        },
        session,
      );
      return company;
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new DomainError(
          'COMPANY_PROFILE_EXISTS',
          'A company with this PAN or GSTIN is already registered.',
          [{ field: 'pan' }],
        );
      throw err;
    }
  }

  async update(user: AuthUser, input: CompanyUpdateInput, ctx: AuditContext): Promise<CompanyDoc> {
    const c = await this.getMine(user);
    if (c.status === 'SUSPENDED')
      throw new DomainError('COMPANY_NOT_ACTIVE', 'This company account is suspended.');
    if (
      c.status === 'ACTIVE' &&
      ((input.legalName && input.legalName !== c.legalName) || (input.gstin && input.gstin !== c.gstin))
    )
      throw new DomainError(
        'STATE_CONFLICT',
        'The legal name and GSTIN of a verified company can only be changed by Bijli Wala support.',
      );
    const billingState = input.billingAddress?.stateCode ?? c.billingAddress.stateCode;
    const gstin = input.gstin ?? c.gstin;
    if (gstin && gstin.slice(0, 2) !== billingState)
      throw new DomainError('VALIDATION_FAILED', 'The GSTIN does not belong to the billing state.', [
        { path: 'gstin', message: 'The GSTIN does not belong to the billing state' },
      ]);
    try {
      const updated = await this.companies
        .findOneAndUpdate(
          { _id: c._id, version: c.version },
          { $set: input, $inc: { version: 1 } },
          { new: true },
        )
        .lean<CompanyDoc>()
        .exec();
      if (!updated)
        throw new DomainError(
          'VERSION_MISMATCH',
          'The company was changed at the same time. Reload and retry.',
        );
      await this.audit.record({
        actor: actorFromUser(user),
        action: 'company.update',
        entityType: 'Company',
        entityId: c._id.toHexString(),
        before: { fields: Object.keys(input) },
        after: input,
        context: ctx,
      });
      return updated;
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new DomainError(
          'COMPANY_PROFILE_EXISTS',
          'This GSTIN is already registered to another company.',
          [{ field: 'gstin' }],
        );
      throw err;
    }
  }

  /* ---------------------------------------------------------------- admin (FR-CMP-02, 04) */

  async list(q: z.infer<typeof companyListQuerySchema>): Promise<{ items: CompanyView[]; meta: PageMeta }> {
    const filter: FilterQuery<CompanyDoc> = {};
    if (q.status) filter.status = q.status;
    if (q.q) filter.$or = [{ legalName: containsText(q.q) }, { gstin: q.q.toUpperCase() }];
    const { docs, meta } = await findPage(this.companies, filter, q);
    return { items: await Promise.all(docs.map((d) => this.toView(d))), meta };
  }

  async setStatus(
    id: string,
    to: CompanyStatus,
    reason: string | undefined,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<CompanyDoc> {
    const allowed: Record<CompanyStatus, CompanyStatus[]> = {
      ACTIVE: ['PENDING_VERIFICATION', 'SUSPENDED'],
      SUSPENDED: ['PENDING_VERIFICATION', 'ACTIVE'],
      PENDING_VERIFICATION: [],
    };
    return this.txn.run(async (session) => {
      const c = await this.getById(id, session);
      if (!allowed[to].includes(c.status))
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `A ${c.status.toLowerCase().replace('_', ' ')} company cannot become ${to.toLowerCase()}.`,
        );
      const firstActivation = to === 'ACTIVE' && !c.activatedAt;
      const updated = await this.companies
        .findOneAndUpdate(
          { _id: c._id, status: c.status },
          {
            $set: {
              status: to,
              ...(reason ? { statusReason: reason } : {}),
              ...(firstActivation
                ? { activatedAt: new Date(), activatedBy: new Types.ObjectId(user.id) }
                : {}),
            },
            ...(to === 'ACTIVE' && !reason ? { $unset: { statusReason: 1 } } : {}),
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean<CompanyDoc>()
        .exec();
      if (!updated) throw new DomainError('STATE_CONFLICT', 'The company changed at the same time. Retry.');
      const admins = await this.adminUserIds(id);
      await this.notifications.request(
        {
          eventType: to === 'ACTIVE' ? 'company.activated' : 'company.suspended',
          priority: 'CRITICAL',
          recipients: admins.map((userId) => ({ userId })),
          data: { company: c.legalName, reason: reason ?? '' },
        },
        session,
      );
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: to === 'ACTIVE' ? 'company.activate' : 'company.suspend',
          entityType: 'Company',
          entityId: id,
          before: { status: c.status },
          after: { status: to },
          ...(reason ? { reason } : {}),
          context: ctx,
        },
        session,
      );
      return updated;
    });
  }

  async setCommercialTerms(
    id: string,
    terms: CommercialTerms,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<CompanyDoc> {
    const before = await this.getById(id);
    const updated = await this.companies
      .findByIdAndUpdate(
        before._id,
        { $set: { commercialTerms: terms }, $inc: { version: 1 } },
        { new: true },
      )
      .lean<CompanyDoc>()
      .exec();
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'company.commercial_terms',
      entityType: 'Company',
      entityId: id,
      before: before.commercialTerms,
      after: terms,
      context: ctx,
    });
    return updated as CompanyDoc;
  }

  async setBlockedProviders(
    id: string,
    input: BlockedProvidersInput,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<CompanyDoc> {
    const before = await this.getById(id);
    const providers = input.providers.map((p) => ({ ...p, id: new Types.ObjectId(p.id) }));
    const updated = await this.companies
      .findByIdAndUpdate(
        before._id,
        { $set: { blockedProviders: providers }, $inc: { version: 1 } },
        { new: true },
      )
      .lean<CompanyDoc>()
      .exec();
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'company.blocked_providers',
      entityType: 'Company',
      entityId: id,
      before: { count: before.blockedProviders.length },
      after: input,
      context: ctx,
    });
    return updated as CompanyDoc;
  }

  /* ---------------------------------------------------------------- sites */

  async listSites(
    companyId: string,
    opts: { includeInactive?: boolean; siteIds?: string[] } = {},
  ): Promise<SiteView[]> {
    const filter: FilterQuery<SiteDoc> = { companyId: new Types.ObjectId(companyId) };
    if (!opts.includeInactive) filter.isActive = true;
    if (opts.siteIds) filter._id = { $in: opts.siteIds.map((s) => new Types.ObjectId(s)) };
    const docs = await this.sites.find(filter).sort({ name: 1 }).lean<SiteDoc[]>().exec();
    return docs.map(toSiteView);
  }

  /** A site of the company; throws NOT_FOUND for another company's site (IDOR). */
  async getSite(
    companyId: string | Types.ObjectId,
    siteId: string,
    session?: ClientSession,
  ): Promise<SiteDoc> {
    const s = Types.ObjectId.isValid(siteId)
      ? await this.sites
          .findOne({ _id: siteId, companyId: new Types.ObjectId(String(companyId)) }, undefined, { session })
          .lean<SiteDoc>()
          .exec()
      : null;
    if (!s) throw new NotFoundError('Site', siteId);
    return s;
  }

  async requireActiveSite(
    companyId: string | Types.ObjectId,
    siteId: string,
    session?: ClientSession,
  ): Promise<SiteDoc> {
    const s = await this.getSite(companyId, siteId, session);
    if (!s.isActive)
      throw new DomainError('SITE_INACTIVE', 'This site is no longer active.', [{ field: 'siteId' }]);
    return s;
  }

  async sitesByIds(ids: Types.ObjectId[]): Promise<Map<string, SiteDoc>> {
    const docs = await this.sites
      .find({ _id: { $in: ids } })
      .lean<SiteDoc[]>()
      .exec();
    return new Map(docs.map((d) => [d._id.toHexString(), d]));
  }

  async createSite(
    companyId: string,
    input: z.infer<typeof siteInputSchema>,
    actor: AuditActor,
    ctx: AuditContext,
  ): Promise<SiteView> {
    await this.requireNotSuspended(companyId);
    const doc = await this.sites.create({
      companyId: new Types.ObjectId(companyId),
      name: input.name,
      address: input.address,
      location: toPoint(input.location),
      timezone: input.timezone,
      contact: input.contact,
      ...(input.geofenceMeters ? { geofenceMeters: input.geofenceMeters } : {}),
      isActive: true,
    });
    await this.audit.record({
      actor,
      action: 'site.create',
      entityType: 'CompanySite',
      entityId: doc._id.toHexString(),
      after: { companyId, name: input.name },
      context: ctx,
    });
    return toSiteView(doc.toObject());
  }

  async updateSite(
    companyId: string,
    siteId: string,
    input: z.infer<typeof siteUpdateSchema>,
    actor: AuditActor,
    ctx: AuditContext,
  ): Promise<SiteView> {
    const site = await this.getSite(companyId, siteId);
    const { location, ...rest } = input;
    const updated = await this.sites
      .findByIdAndUpdate(
        site._id,
        { $set: { ...rest, ...(location ? { location: toPoint(location) } : {}) } },
        { new: true },
      )
      .lean<SiteDoc>()
      .exec();
    await this.audit.record({
      actor,
      action: input.isActive === false ? 'site.deactivate' : 'site.update',
      entityType: 'CompanySite',
      entityId: siteId,
      after: { fields: Object.keys(input) },
      context: ctx,
    });
    return toSiteView(updated as SiteDoc);
  }

  /* ---------------------------------------------------------------- team (FR-CMP-03) */

  async listUsers(companyId: string, me?: AuthUser): Promise<CompanyUserView[]> {
    const company = await this.getById(companyId);
    const grants = (await this.roles.assignmentsInCompany(companyId)).filter((g) =>
      (COMPANY_ROLES as string[]).includes(g.roleCode),
    );
    const people = await this.users.findByIds([...new Set(grants.map((g) => g.userId.toHexString()))]);
    const byId = new Map(people.map((p) => [p._id.toHexString(), p]));
    return grants
      .flatMap((g): CompanyUserView[] => {
        const p = byId.get(g.userId.toHexString());
        if (!p) return [];
        return [
          {
            userId: p._id.toHexString(),
            name: p.name,
            ...(p.mobile ? { mobile: p.mobile } : {}),
            roleCode: g.roleCode as CompanyRoleCode,
            ...(g.scope.siteIds?.length ? { siteIds: g.scope.siteIds.map((s) => s.toHexString()) } : {}),
            status: p.status,
            isPrimaryContact: p._id.equals(company.primaryContactUserId),
            isYou: me?.id === p._id.toHexString(),
          },
        ];
      })
      .sort((a, b) => a.roleCode.localeCompare(b.roleCode) || a.name.localeCompare(b.name));
  }

  async inviteUser(
    user: AuthUser,
    input: CompanyUserInviteInput,
    ctx: AuditContext,
  ): Promise<CompanyUserView[]> {
    const { companyId } = requireCompanyScope(user);
    const company = await this.requireNotSuspended(companyId);
    if (input.siteIds?.length) {
      const count = await this.sites.countDocuments({
        companyId: company._id,
        _id: { $in: input.siteIds.map((s) => new Types.ObjectId(s)) },
      });
      if (count !== new Set(input.siteIds).size)
        throw new DomainError('VALIDATION_FAILED', 'Choose sites of your company.', [
          { path: 'siteIds', message: 'Unknown site' },
        ]);
    }
    const actor = actorFromUser(user);
    const invitedId = await this.txn.run(async (session) => {
      let target = await this.users.findByMobile(input.mobile, session);
      if (target && target.userType !== 'COMPANY')
        throw new DomainError(
          'COMPANY_USER_CONFLICT',
          'This mobile number is used by a provider or admin account. Use another number.',
          [{ field: 'mobile' }],
        );
      if (target) {
        const grants = await this.roles.activeAssignmentsFor(target._id, session);
        const inCompany = grants.filter((g) => g.scope.type === 'COMPANY');
        if (inCompany.some((g) => g.scope.companyId && !g.scope.companyId.equals(company._id)))
          throw new DomainError('COMPANY_USER_CONFLICT', 'This person already belongs to another company.', [
            { field: 'mobile' },
          ]);
        if (inCompany.length > 0)
          throw new DomainError(
            'COMPANY_USER_CONFLICT',
            'This person is already in your team. Remove them first to change their role.',
            [{ field: 'mobile' }],
          );
      } else {
        target = await this.users.createInvited(
          { name: input.name, mobile: input.mobile, userType: 'COMPANY' },
          session,
        );
      }
      const targetId = target._id.toHexString();
      await this.roles.grant(
        targetId,
        {
          roleCode: input.roleCode,
          scope: { type: 'COMPANY', companyId, ...(input.siteIds?.length ? { siteIds: input.siteIds } : {}) },
        },
        actor,
        ctx,
        session,
      );
      await this.notifications.request(
        {
          eventType: 'company.user_invited',
          priority: 'CRITICAL',
          recipients: [{ userId: targetId }],
          data: { name: target.name, company: company.legalName, inviter: user.id },
        },
        session,
      );
      return targetId;
    });
    await this.audit.record({
      actor,
      action: 'company.user_invite',
      entityType: 'Company',
      entityId: companyId,
      after: { userId: invitedId, roleCode: input.roleCode, siteIds: input.siteIds ?? [] },
      context: ctx,
    });
    return this.listUsers(companyId, user);
  }

  async removeUser(user: AuthUser, userId: string, ctx: AuditContext): Promise<CompanyUserView[]> {
    const { companyId } = requireCompanyScope(user);
    const company = await this.getById(companyId);
    if (userId === user.id) throw new DomainError('STATE_CONFLICT', 'You cannot remove yourself.');
    if (company.primaryContactUserId.toHexString() === userId)
      throw new DomainError('STATE_CONFLICT', 'The primary contact cannot be removed.');
    const grants = (await this.roles.assignmentsInCompany(companyId)).filter(
      (g) => g.userId.toHexString() === userId,
    );
    if (grants.length === 0) throw new NotFoundError('Team member', userId);
    for (const g of grants) {
      await this.roles.revoke(userId, g._id.toHexString(), actorFromUser(user), ctx);
    }
    return this.listUsers(companyId, user);
  }
}

/* ================================================================ controllers */

class CompanyCreateDto extends createZodDto(companyCreateSchema) {}
class CompanyUpdateDto extends createZodDto(companyUpdateSchema) {}
class SiteDto extends createZodDto(siteInputSchema) {}
class SiteUpdateDto extends createZodDto(siteUpdateSchema) {}
class InviteDto extends createZodDto(companyUserInviteSchema) {}
class CompanyListDto extends createZodDto(companyListQuerySchema) {}
class ReasonDto extends createZodDto(companyStatusChangeSchema) {}
class ActivateDto extends createZodDto(z.object({ note: z.string().trim().max(500).optional() }).strict()) {}
class TermsDto extends createZodDto(commercialTermsSchema) {}
class BlockedDto extends createZodDto(blockedProvidersSchema) {}

@ApiTags('Companies')
@ApiBearerAuth()
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  /** Any signed-in company account without a company may register one (no company role yet). */
  @Post()
  @ApiZodBody(CompanyCreateDto)
  async create(
    @Body() dto: CompanyCreateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<CompanyView> {
    return this.companies.toView(await this.companies.create(user, dto, ctx));
  }

  /** Every member of the company may read it. */
  @Get('me')
  async me(@CurrentUser() user: AuthUser): Promise<CompanyView> {
    return this.companies.toView(await this.companies.getMine(user));
  }

  @Patch('me')
  @RequirePermissions('company.manage')
  @ApiZodBody(CompanyUpdateDto)
  async update(
    @Body() dto: CompanyUpdateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<CompanyView> {
    return this.companies.toView(await this.companies.update(user, dto, ctx));
  }

  /** Site-restricted members only see their own sites. */
  @Get('me/sites')
  sites(@CurrentUser() user: AuthUser): Promise<SiteView[]> {
    const scope = requireCompanyScope(user);
    return this.companies.listSites(scope.companyId, {
      includeInactive: user.permissions.has('site.manage'),
      ...(scope.siteIds ? { siteIds: scope.siteIds } : {}),
    });
  }

  @Post('me/sites')
  @RequirePermissions('site.manage')
  @ApiZodBody(SiteDto)
  createSite(
    @Body() dto: SiteDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<SiteView> {
    return this.companies.createSite(requireCompanyScope(user).companyId, dto, actorFromUser(user), ctx);
  }

  @Patch('me/sites/:id')
  @RequirePermissions('site.manage')
  @ApiZodBody(SiteUpdateDto)
  updateSite(
    @Param('id') id: string,
    @Body() dto: SiteUpdateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<SiteView> {
    return this.companies.updateSite(requireCompanyScope(user).companyId, id, dto, actorFromUser(user), ctx);
  }

  @Get('me/users')
  @RequirePermissions('company.users.manage')
  users(@CurrentUser() user: AuthUser): Promise<CompanyUserView[]> {
    return this.companies.listUsers(requireCompanyScope(user).companyId, user);
  }

  @Post('me/users')
  @RequirePermissions('company.users.manage')
  @ApiZodBody(InviteDto)
  invite(
    @Body() dto: InviteDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<CompanyUserView[]> {
    return this.companies.inviteUser(user, dto, ctx);
  }

  @Delete('me/users/:userId')
  @RequirePermissions('company.users.manage')
  remove(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<CompanyUserView[]> {
    return this.companies.removeUser(user, userId, ctx);
  }
}

@ApiTags('Companies (admin)')
@ApiBearerAuth()
@PlatformOnly()
@Controller('admin/companies')
export class AdminCompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  @RequirePermissions('company.read')
  @ApiZodQuery(CompanyListDto)
  async list(@Query() q: CompanyListDto): Promise<PagedResult<CompanyView>> {
    const { items, meta } = await this.companies.list(q);
    return new PagedResult(items, meta);
  }

  @Get(':id')
  @RequirePermissions('company.read')
  async get(@Param('id') id: string): Promise<CompanyView> {
    return this.companies.toView(await this.companies.getById(id));
  }

  @Get(':id/sites')
  @RequirePermissions('company.read')
  async sites(@Param('id') id: string): Promise<SiteView[]> {
    const c = await this.companies.getById(id);
    return this.companies.listSites(c._id.toHexString(), { includeInactive: true });
  }

  @Post(':id/sites')
  @RequirePermissions('company.activate')
  @ApiZodBody(SiteDto)
  async addSite(
    @Param('id') id: string,
    @Body() dto: SiteDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<SiteView> {
    const c = await this.companies.getById(id);
    return this.companies.createSite(c._id.toHexString(), dto, actorFromUser(user), ctx);
  }

  @Get(':id/users')
  @RequirePermissions('company.read')
  async users(@Param('id') id: string): Promise<CompanyUserView[]> {
    const c = await this.companies.getById(id);
    return this.companies.listUsers(c._id.toHexString());
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermissions('company.activate')
  @ApiZodBody(ActivateDto)
  async activate(
    @Param('id') id: string,
    @Body() dto: ActivateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<CompanyView> {
    return this.companies.toView(await this.companies.setStatus(id, 'ACTIVE', dto.note, user, ctx));
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermissions('company.activate')
  @ApiZodBody(ReasonDto)
  async suspend(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<CompanyView> {
    return this.companies.toView(await this.companies.setStatus(id, 'SUSPENDED', dto.reason, user, ctx));
  }

  @Put(':id/commercial-terms')
  @RequirePermissions('company.activate')
  @ApiZodBody(TermsDto)
  async terms(
    @Param('id') id: string,
    @Body() dto: TermsDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<CompanyView> {
    return this.companies.toView(await this.companies.setCommercialTerms(id, dto, user, ctx));
  }

  @Put(':id/blocked-providers')
  @RequirePermissions('company.activate')
  @ApiZodBody(BlockedDto)
  async blocked(
    @Param('id') id: string,
    @Body() dto: BlockedDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<CompanyView> {
    return this.companies.toView(await this.companies.setBlockedProviders(id, dto, user, ctx));
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: COMPANY_MODEL, schema: companySchema },
      { name: SITE_MODEL, schema: siteSchema },
    ]),
    UsersModule,
    DocumentsModule,
    NotificationsModule,
  ],
  controllers: [CompaniesController, AdminCompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
