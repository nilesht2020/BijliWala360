import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Schema, Types, type ClientSession, type Model } from 'mongoose';
import {
  identityConflictResolveSchema,
  normaliseIdNumber,
  type IdentityConflictView,
  type IdType,
} from '@bijliwala/contracts';
import { actorFromUser, AuditService, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, RequirePermissions } from '../../core/auth/decorators';
import { FieldCrypto } from '../../core/crypto/field-crypto';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { ReqContext } from '../../core/http/request-context';
import { ApiZodBody, createZodDto } from '../../core/http/zod';

/* ================================================================ schemas (DATABASE §5) */

export const PERSON_MODEL = 'Person';
export const IDENTITY_CONFLICT_MODEL = 'IdentityConflict';

export type PersonRole =
  | { type: 'PROFESSIONAL'; refId: Types.ObjectId }
  | { type: 'VENDOR_WORKER'; refId: Types.ObjectId; vendorId: Types.ObjectId };

export interface PersonDoc {
  _id: Types.ObjectId;
  fullName: string;
  idType: IdType;
  idHash: string;
  idLast4: string;
  mobileHash?: string;
  activeRole?: PersonRole;
  isActive: boolean;
  /** Write-lock counter used to serialise scheduling per person (ARCHITECTURE §6.3, Phase 5). */
  scheduleVersion: number;
}

interface ConflictDoc {
  _id: Types.ObjectId;
  attemptedRole: {
    type: PersonRole['type'];
    vendorId?: Types.ObjectId;
    refId?: Types.ObjectId;
    name: string;
  };
  existingPersonId: Types.ObjectId;
  existingRole?: PersonRole;
  matchedOn: Array<'ID' | 'MOBILE'>;
  status: 'OPEN' | 'RESOLVED';
  note?: string;
  resolvedBy?: string;
  createdAt: Date;
}

const roleSchema = new Schema(
  { type: String, refId: Schema.Types.ObjectId, vendorId: Schema.Types.ObjectId },
  { _id: false },
);

const personSchema = new Schema<PersonDoc>(
  {
    fullName: { type: String, required: true },
    idType: { type: String, required: true },
    idHash: { type: String, required: true },
    idLast4: { type: String, required: true },
    mobileHash: String,
    activeRole: { type: roleSchema },
    isActive: { type: Boolean, required: true, default: true },
    scheduleVersion: { type: Number, required: true, default: 0 },
  },
  { collection: 'persons', timestamps: true, versionKey: false },
);
// One ACTIVE identity per ID number and per mobile across the whole platform (BR-PRV-01).
personSchema.index({ idHash: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
personSchema.index(
  { mobileHash: 1 },
  { unique: true, partialFilterExpression: { isActive: true, mobileHash: { $type: 'string' } } },
);

const conflictSchema = new Schema<ConflictDoc>(
  {
    attemptedRole: {
      type: new Schema(
        { type: String, vendorId: Schema.Types.ObjectId, refId: Schema.Types.ObjectId, name: String },
        { _id: false },
      ),
      required: true,
    },
    existingPersonId: { type: Schema.Types.ObjectId, required: true },
    existingRole: { type: roleSchema },
    matchedOn: { type: [String], default: [] },
    status: { type: String, enum: ['OPEN', 'RESOLVED'], default: 'OPEN' },
    note: String,
    resolvedBy: String,
  },
  { collection: 'identity_conflicts', timestamps: true, versionKey: false },
);
conflictSchema.index({ status: 1, createdAt: -1 });

/* ================================================================ service */

export interface ClaimInput {
  fullName: string;
  idType: IdType;
  /** From PersonsService.hashId(): providers never keep the raw ID number around for this. */
  idHash: string;
  idLast4: string;
  mobile?: string;
  role: { type: 'PROFESSIONAL'; refId: string } | { type: 'VENDOR_WORKER'; refId: string; vendorId: string };
}

function toRole(r: ClaimInput['role']): PersonRole {
  return r.type === 'PROFESSIONAL'
    ? { type: 'PROFESSIONAL', refId: new Types.ObjectId(r.refId) }
    : { type: 'VENDOR_WORKER', refId: new Types.ObjectId(r.refId), vendorId: new Types.ObjectId(r.vendorId) };
}

/**
 * Person Registry (FR-VWK-04, BR-PRV-01): one active provider identity per natural person,
 * identified by a peppered hash of the government ID number and of the mobile number. A second
 * active claim is refused (PERSON_ALREADY_ACTIVE) and recorded for the identity-conflict queue.
 */
@Injectable()
export class PersonsService {
  constructor(
    @InjectModel(PERSON_MODEL) private readonly persons: Model<PersonDoc>,
    @InjectModel(IDENTITY_CONFLICT_MODEL) private readonly conflicts: Model<ConflictDoc>,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditService,
  ) {}

  hashId(idType: IdType, idNumber: string): string {
    return this.crypto.hash(normaliseIdNumber(idNumber), `PERSON_ID:${idType}`);
  }

  hashMobile(mobile: string): string {
    return this.crypto.hash(mobile, 'PERSON_MOBILE');
  }

  /** Claims (or re-claims) an identity for a provider role inside the caller's transaction. */
  async claim(input: ClaimInput, session: ClientSession): Promise<PersonDoc> {
    const { idHash } = input;
    const mobileHash = input.mobile ? this.hashMobile(input.mobile) : undefined;
    const role = toRole(input.role);
    const or: Array<Record<string, unknown>> = [{ idHash }];
    if (mobileHash) or.push({ mobileHash });
    const existing = await this.persons
      .find({ isActive: true, $or: or }, undefined, { session })
      .lean<PersonDoc[]>()
      .exec();

    for (const p of existing) {
      const sameRole = p.activeRole?.type === role.type && p.activeRole.refId.equals(role.refId);
      if (!sameRole) {
        throw Object.assign(
          new DomainError(
            'PERSON_ALREADY_ACTIVE',
            'This person is already registered on Bijli Wala with another active profile.',
          ),
          {
            conflict: {
              existing: p,
              matchedOn: [
                ...(p.idHash === idHash ? ['ID'] : []),
                ...(mobileHash && p.mobileHash === mobileHash ? ['MOBILE'] : []),
              ],
            },
          },
        );
      }
    }
    const mine = existing[0];
    if (mine) {
      await this.persons.updateOne(
        { _id: mine._id },
        {
          $set: {
            fullName: input.fullName,
            idType: input.idType,
            idHash,
            idLast4: input.idLast4,
            ...(mobileHash ? { mobileHash } : {}),
          },
        },
        { session },
      );
      return { ...mine, idHash };
    }
    try {
      const [doc] = await this.persons.create(
        [
          {
            fullName: input.fullName,
            idType: input.idType,
            idHash,
            idLast4: input.idLast4,
            ...(mobileHash ? { mobileHash } : {}),
            activeRole: role,
            isActive: true,
            scheduleVersion: 0,
          },
        ],
        { session },
      );
      return (doc as unknown as { toObject(): PersonDoc }).toObject();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new DomainError(
          'PERSON_ALREADY_ACTIVE',
          'This person is already registered on Bijli Wala with another active profile.',
        );
      }
      throw err;
    }
  }

  /** Records a refused claim for the admin conflict queue (called after the failed transaction). */
  async recordConflict(
    err: unknown,
    attempted: { type: PersonRole['type']; vendorId?: string; refId?: string; name: string },
  ): Promise<void> {
    const conflict = (err as { conflict?: { existing: PersonDoc; matchedOn: Array<'ID' | 'MOBILE'> } })
      .conflict;
    if (!conflict) return;
    await this.conflicts.create({
      attemptedRole: {
        type: attempted.type,
        name: attempted.name,
        ...(attempted.vendorId ? { vendorId: new Types.ObjectId(attempted.vendorId) } : {}),
        ...(attempted.refId ? { refId: new Types.ObjectId(attempted.refId) } : {}),
      },
      existingPersonId: conflict.existing._id,
      ...(conflict.existing.activeRole ? { existingRole: conflict.existing.activeRole } : {}),
      matchedOn: conflict.matchedOn,
      status: 'OPEN',
    });
  }

  async release(personId: Types.ObjectId, session: ClientSession): Promise<void> {
    await this.persons.updateOne(
      { _id: personId },
      { $set: { isActive: false }, $unset: { activeRole: 1 } },
      { session },
    );
  }

  async listConflicts(): Promise<IdentityConflictView[]> {
    const docs = await this.conflicts
      .find()
      .sort({ status: 1, createdAt: -1 })
      .limit(200)
      .lean<ConflictDoc[]>()
      .exec();
    return docs.map((c) => ({
      id: c._id.toHexString(),
      attemptedRole: {
        type: c.attemptedRole.type,
        name: c.attemptedRole.name,
        ...(c.attemptedRole.vendorId ? { vendorId: c.attemptedRole.vendorId.toHexString() } : {}),
        ...(c.attemptedRole.refId ? { refId: c.attemptedRole.refId.toHexString() } : {}),
      },
      ...(c.existingRole
        ? {
            existingRole: {
              type: c.existingRole.type,
              refId: c.existingRole.refId.toHexString(),
              ...('vendorId' in c.existingRole && c.existingRole.vendorId
                ? { vendorId: c.existingRole.vendorId.toHexString() }
                : {}),
            },
          }
        : {}),
      matchedOn: c.matchedOn,
      status: c.status,
      ...(c.note ? { note: c.note } : {}),
      createdAt: c.createdAt.toISOString(),
    }));
  }

  async resolveConflict(id: string, note: string, user: AuthUser, ctx: AuditContext): Promise<void> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Identity conflict', id);
    const res = await this.conflicts.updateOne(
      { _id: id, status: 'OPEN' },
      { $set: { status: 'RESOLVED', note, resolvedBy: user.id } },
    );
    if (res.matchedCount === 0) throw new NotFoundError('Open identity conflict', id);
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'identity_conflict.resolve',
      entityType: 'IdentityConflict',
      entityId: id,
      reason: note,
      context: ctx,
    });
  }
}

class ResolveDto extends createZodDto(identityConflictResolveSchema) {}

@ApiTags('Identity conflicts (admin)')
@ApiBearerAuth()
@Controller('admin/identity-conflicts')
@RequirePermissions('identity.resolve')
export class IdentityConflictsController {
  constructor(private readonly persons: PersonsService) {}

  @Get()
  list(): Promise<IdentityConflictView[]> {
    return this.persons.listConflicts();
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @ApiZodBody(ResolveDto)
  async resolve(
    @Param('id') id: string,
    @Body() dto: ResolveDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<{ resolved: true }> {
    await this.persons.resolveConflict(id, dto.note, user, ctx);
    return { resolved: true };
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PERSON_MODEL, schema: personSchema },
      { name: IDENTITY_CONFLICT_MODEL, schema: conflictSchema },
    ]),
  ],
  controllers: [IdentityConflictsController],
  providers: [PersonsService],
  exports: [PersonsService],
})
export class PersonsModule {}
