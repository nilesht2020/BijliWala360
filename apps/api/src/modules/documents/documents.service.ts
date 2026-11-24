import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Schema, Types, type ClientSession, type Model } from 'mongoose';
import {
  ACTIVE_DOCUMENT_STATUSES,
  DOCUMENT_OWNER_TYPES,
  DOCUMENT_STATUSES,
  type DocumentOwnerType,
  type DocumentReviewInput,
  type DocumentStatus,
  type DocumentTypeInput,
  type DocumentTypeView,
  type DocumentView,
  type UploadIntentInput,
  type UploadIntentResponse,
} from '@bijliwala/contracts';
import { actorFromUser, AuditService, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { hasPermission, isPlatformUser } from '../../core/auth/guards';
import { BusinessConfigService } from '../../core/business-config/business-config.service';
import { FieldCrypto, type EncryptedValue } from '../../core/crypto/field-crypto';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { VIRUS_SCANNER, type VirusScanner } from '../../core/scanning/clamav.client';
import { StorageService } from '../../core/storage/storage.service';

/* ================================================================ schemas (DATABASE §6) */

export const DOCUMENT_TYPE_MODEL = 'DocumentType';
export const DOCUMENT_MODEL = 'Document';

interface DocumentTypeDoc extends DocumentTypeInput {
  _id: Types.ObjectId;
}

export interface DocumentDoc {
  _id: Types.ObjectId;
  typeCode: string;
  owner: { type: DocumentOwnerType; id: Types.ObjectId };
  uploadedBy: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  storageKey: string;
  numberEnc?: EncryptedValue;
  numberHash?: string;
  numberLast4?: string;
  expiresOn?: string;
  status: DocumentStatus;
  versionNo: number;
  flags: string[];
  rejectionReason?: string;
  review?: { by: string; at: Date; decision: 'VERIFIED' | 'REJECTED'; comment?: string };
  uploadIntentExpiresAt: Date;
  createdAt: Date;
}

export const documentTypeSchema = new Schema<DocumentTypeDoc>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    ownerTypes: { type: [String], enum: DOCUMENT_OWNER_TYPES, default: [] },
    allowedMime: { type: [String], default: [] },
    maxSizeBytes: { type: Number, required: true },
    hasExpiry: { type: Boolean, default: false },
    captureNumber: { type: Boolean, default: false },
    numberPattern: String,
    isSensitive: { type: Boolean, default: false },
    reminderDaysBefore: { type: [Number], default: [30, 7] },
    isActive: { type: Boolean, default: true },
  },
  { collection: 'document_types', timestamps: true, versionKey: false },
);
documentTypeSchema.index({ code: 1 }, { unique: true });

export const documentSchema = new Schema<DocumentDoc>(
  {
    typeCode: { type: String, required: true },
    owner: {
      type: new Schema(
        {
          type: { type: String, enum: DOCUMENT_OWNER_TYPES, required: true },
          id: { type: Schema.Types.ObjectId, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    uploadedBy: { type: String, required: true },
    fileName: { type: String, required: true },
    mime: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    storageKey: { type: String, required: true },
    numberEnc: { type: new Schema({ ct: String, iv: String, tag: String, kv: Number }, { _id: false }) },
    numberHash: String,
    numberLast4: String,
    expiresOn: String,
    status: { type: String, enum: DOCUMENT_STATUSES, required: true },
    versionNo: { type: Number, required: true },
    flags: { type: [String], default: [] },
    rejectionReason: String,
    review: { type: new Schema({ by: String, at: Date, decision: String, comment: String }, { _id: false }) },
    uploadIntentExpiresAt: { type: Date, required: true },
  },
  { collection: 'documents', timestamps: true, versionKey: false },
);
documentSchema.index({ 'owner.type': 1, 'owner.id': 1, typeCode: 1, status: 1 });
documentSchema.index({ status: 1, expiresOn: 1 });
documentSchema.index({ numberHash: 1 }, { sparse: true });
documentSchema.index({ status: 1, uploadIntentExpiresAt: 1 });

/* ================================================================ owner access registry */

/**
 * Each owning module registers how to decide whether a user may act on its documents
 * (e.g. Professionals: "is this my professional profile?"). This keeps Documents independent of
 * the provider modules (no circular imports) while still enforcing ownership (IDOR defence).
 */
export interface DocumentOwnerPolicy {
  /** True when the user may upload/read documents for this owner as its owner (not as an admin). */
  isOwner(user: AuthUser, ownerId: string): Promise<boolean>;
}

/* ================================================================ file signature sniffing */

/** Detects the real type of a file from its first bytes; returns null for anything else. */
export function sniffMime(head: Buffer): string | null {
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  return null;
}

const DEFAULT_TYPES: DocumentTypeInput[] = [
  {
    code: 'PHOTO',
    name: 'Profile photo',
    ownerTypes: ['PROFESSIONAL', 'VENDOR_WORKER'],
    allowedMime: ['image/jpeg', 'image/png', 'image/webp'],
    maxSizeBytes: 3 * 1024 * 1024,
    hasExpiry: false,
    captureNumber: false,
    isSensitive: false,
    reminderDaysBefore: [],
    isActive: true,
  },
  {
    code: 'PAN_CARD',
    name: 'PAN card',
    ownerTypes: ['PROFESSIONAL', 'VENDOR', 'COMPANY'],
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 5 * 1024 * 1024,
    hasExpiry: false,
    captureNumber: true,
    numberPattern: '^[A-Z]{5}[0-9]{4}[A-Z]$',
    isSensitive: true,
    reminderDaysBefore: [],
    isActive: true,
  },
  {
    code: 'AADHAAR_MASKED',
    name: 'Masked Aadhaar',
    description: 'Upload the masked Aadhaar showing only the last 4 digits.',
    ownerTypes: ['PROFESSIONAL', 'VENDOR_WORKER'],
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 5 * 1024 * 1024,
    hasExpiry: false,
    captureNumber: false,
    isSensitive: true,
    reminderDaysBefore: [],
    isActive: true,
  },
  {
    code: 'ID_PROOF',
    name: 'Government ID',
    ownerTypes: ['VENDOR_WORKER'],
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 5 * 1024 * 1024,
    hasExpiry: false,
    captureNumber: false,
    isSensitive: true,
    reminderDaysBefore: [],
    isActive: true,
  },
  {
    code: 'GST_CERT',
    name: 'GST registration certificate',
    ownerTypes: ['VENDOR', 'COMPANY'],
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 5 * 1024 * 1024,
    hasExpiry: false,
    captureNumber: false,
    isSensitive: false,
    reminderDaysBefore: [],
    isActive: true,
  },
  {
    code: 'TRADE_LICENCE',
    name: 'Trade licence',
    ownerTypes: ['VENDOR'],
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 5 * 1024 * 1024,
    hasExpiry: true,
    captureNumber: false,
    isSensitive: false,
    reminderDaysBefore: [30, 7],
    isActive: true,
  },
  {
    code: 'SKILL_CERT',
    name: 'Skill certificate',
    ownerTypes: ['PROFESSIONAL', 'VENDOR_WORKER'],
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 5 * 1024 * 1024,
    hasExpiry: true,
    captureNumber: false,
    isSensitive: false,
    reminderDaysBefore: [30, 7],
    isActive: true,
  },
  {
    code: 'ELECTRICAL_LICENCE',
    name: 'Electrical licence',
    ownerTypes: ['PROFESSIONAL', 'VENDOR_WORKER'],
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 5 * 1024 * 1024,
    hasExpiry: true,
    captureNumber: true,
    isSensitive: false,
    reminderDaysBefore: [30, 7],
    isActive: true,
  },
  {
    code: 'POLICE_VERIFICATION',
    name: 'Police verification',
    ownerTypes: ['PROFESSIONAL', 'VENDOR_WORKER'],
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 5 * 1024 * 1024,
    hasExpiry: true,
    captureNumber: false,
    isSensitive: true,
    reminderDaysBefore: [30],
    isActive: true,
  },
  {
    code: 'CANCELLED_CHEQUE',
    name: 'Cancelled cheque',
    ownerTypes: ['PROFESSIONAL', 'VENDOR'],
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 5 * 1024 * 1024,
    hasExpiry: false,
    captureNumber: false,
    isSensitive: true,
    reminderDaysBefore: [],
    isActive: true,
  },
  {
    code: 'PAYMENT_PROOF',
    name: 'Payment proof',
    ownerTypes: ['PROFESSIONAL', 'VENDOR', 'COMPANY'],
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 5 * 1024 * 1024,
    hasExpiry: false,
    captureNumber: false,
    isSensitive: false,
    reminderDaysBefore: [],
    isActive: true,
  },
];

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export function toDocumentView(d: DocumentDoc, typeName?: string): DocumentView {
  return {
    id: d._id.toHexString(),
    typeCode: d.typeCode,
    ...(typeName ? { typeName } : {}),
    owner: { type: d.owner.type, id: d.owner.id.toHexString() },
    fileName: d.fileName,
    mime: d.mime,
    sizeBytes: d.sizeBytes,
    status: d.status,
    versionNo: d.versionNo,
    ...(d.numberLast4 ? { numberLast4: d.numberLast4 } : {}),
    ...(d.expiresOn ? { expiresOn: d.expiresOn } : {}),
    ...(d.review
      ? {
          review: {
            decision: d.review.decision,
            ...(d.review.comment ? { comment: d.review.comment } : {}),
            at: d.review.at.toISOString(),
          },
        }
      : {}),
    ...(d.rejectionReason ? { rejectionReason: d.rejectionReason } : {}),
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * Documents (SRS §4.7, ARCHITECTURE §6.7). Uploads go straight to private storage through a
 * short-lived signed URL; on completion the server checks size, sniffs the real file type from
 * its bytes, scans it, and only then moves it from quarantine to the clean area.
 */
@Injectable()
export class DocumentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly owners = new Map<DocumentOwnerType, DocumentOwnerPolicy>();

  constructor(
    @InjectModel(DOCUMENT_TYPE_MODEL) private readonly types: Model<DocumentTypeDoc>,
    @InjectModel(DOCUMENT_MODEL) private readonly documents: Model<DocumentDoc>,
    private readonly storage: StorageService,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    private readonly crypto: FieldCrypto,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const t of DEFAULT_TYPES) {
      try {
        await this.types.updateOne({ code: t.code }, { $setOnInsert: t }, { upsert: true });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
    }
    this.logger.log('Default document types ensured');
  }

  registerOwner(type: DocumentOwnerType, policy: DocumentOwnerPolicy): void {
    this.owners.set(type, policy);
  }

  /* ------------------------------------------------------------------ access */

  private async isOwner(user: AuthUser, type: DocumentOwnerType, ownerId: string): Promise<boolean> {
    const policy = this.owners.get(type);
    return !!policy && (await policy.isOwner(user, ownerId));
  }

  private isReviewer(user: AuthUser): boolean {
    return isPlatformUser(user) && hasPermission(user, 'document.read');
  }

  private async assertCanRead(user: AuthUser, doc: DocumentDoc): Promise<void> {
    if (this.isReviewer(user)) return;
    if (await this.isOwner(user, doc.owner.type, doc.owner.id.toHexString())) return;
    throw new NotFoundError('Document', doc._id.toHexString()); // never reveal other owners' documents
  }

  /* ------------------------------------------------------------------ types */

  async listTypes(includeInactive = false): Promise<DocumentTypeView[]> {
    const docs = await this.types
      .find(includeInactive ? {} : { isActive: true })
      .sort({ name: 1 })
      .lean<DocumentTypeDoc[]>()
      .exec();
    return docs.map(({ _id, ...rest }) => ({ ...rest, id: _id.toHexString() }) as DocumentTypeView);
  }

  async upsertType(input: DocumentTypeInput, user: AuthUser, ctx: AuditContext): Promise<DocumentTypeView> {
    const doc = await this.types
      .findOneAndUpdate({ code: input.code }, { $set: input }, { upsert: true, new: true })
      .lean<DocumentTypeDoc>()
      .exec();
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'document_type.save',
      entityType: 'DocumentType',
      entityId: input.code,
      after: input,
      context: ctx,
    });
    const { _id, ...rest } = doc as DocumentTypeDoc;
    return { ...rest, id: _id.toHexString() } as DocumentTypeView;
  }

  private async getType(code: string): Promise<DocumentTypeDoc> {
    const type = await this.types.findOne({ code, isActive: true }).lean<DocumentTypeDoc>().exec();
    if (!type)
      throw new DomainError('VALIDATION_FAILED', `Unknown document type ${code}.`, [{ field: 'typeCode' }]);
    return type;
  }

  /* ------------------------------------------------------------------ upload */

  async createUploadIntent(input: UploadIntentInput, user: AuthUser): Promise<UploadIntentResponse> {
    const type = await this.getType(input.typeCode);
    if (!type.ownerTypes.includes(input.owner.type)) {
      throw new DomainError('UPLOAD_TYPE_NOT_ALLOWED', `${type.name} cannot be attached here.`, [
        { field: 'typeCode' },
      ]);
    }
    if (!(await this.isOwner(user, input.owner.type, input.owner.id)))
      throw new NotFoundError('Document owner', input.owner.id);
    if (!(type.allowedMime as string[]).includes(input.mime)) {
      throw new DomainError(
        'UPLOAD_TYPE_NOT_ALLOWED',
        `Upload a ${type.allowedMime.map((m) => m.split('/')[1]?.toUpperCase()).join(', ')} file.`,
        [{ field: 'mime' }],
      );
    }
    if (input.sizeBytes > type.maxSizeBytes) {
      throw new DomainError(
        'UPLOAD_TOO_LARGE',
        `The file must be at most ${(type.maxSizeBytes / 1024 / 1024).toFixed(1)} MB.`,
        [{ field: 'sizeBytes' }],
      );
    }
    if (type.hasExpiry && !input.expiresOn)
      throw new DomainError('VALIDATION_FAILED', 'Enter the expiry date.', [
        { path: 'expiresOn', message: 'Required' },
      ]);
    let number: Pick<DocumentDoc, 'numberEnc' | 'numberHash' | 'numberLast4'> = {};
    const flags: string[] = [];
    if (type.captureNumber) {
      const raw = (input.number ?? '').replace(/[\s-]+/g, '').toUpperCase();
      if (!raw)
        throw new DomainError('VALIDATION_FAILED', 'Enter the document number.', [
          { path: 'number', message: 'Required' },
        ]);
      if (type.numberPattern && !new RegExp(type.numberPattern).test(raw)) {
        throw new DomainError('VALIDATION_FAILED', 'The document number is not in the expected format.', [
          { path: 'number', message: 'Invalid format' },
        ]);
      }
      const numberHash = this.crypto.hash(raw, `DOC:${type.code}`);
      number = { numberEnc: this.crypto.encrypt(raw), numberHash, numberLast4: raw.slice(-4) };
      const dup = await this.documents.exists({
        numberHash,
        status: { $in: ['UPLOADED', 'VERIFIED', 'SCANNING'] },
        $or: [
          { 'owner.type': { $ne: input.owner.type } },
          { 'owner.id': { $ne: new Types.ObjectId(input.owner.id) } },
        ],
      });
      if (dup) flags.push('DUPLICATE_NUMBER'); // surfaced to the verification officer (FR-DOC-05)
    }

    const ttl = await this.config.get('documents.uploadUrlTtlSeconds');
    const owner = { type: input.owner.type, id: new Types.ObjectId(input.owner.id) };
    const last = await this.documents
      .findOne({ 'owner.type': owner.type, 'owner.id': owner.id, typeCode: type.code })
      .sort({ versionNo: -1 })
      .lean<DocumentDoc>()
      .exec();
    const _id = new Types.ObjectId();
    const storageKey = `quarantine/${_id.toHexString()}`;
    const presigned = await this.storage.presignUpload(storageKey, input.mime, input.sizeBytes, ttl);
    await this.documents.create({
      _id,
      typeCode: type.code,
      owner,
      uploadedBy: user.id,
      fileName: input.fileName.replace(/[\\/:*?"<>|]+/g, '_'),
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      storageKey,
      ...number,
      ...(input.expiresOn ? { expiresOn: input.expiresOn } : {}),
      status: 'PENDING_UPLOAD',
      versionNo: (last?.versionNo ?? 0) + 1,
      flags,
      uploadIntentExpiresAt: presigned.expiresAt,
    });
    return {
      documentId: _id.toHexString(),
      uploadUrl: presigned.url,
      method: 'PUT',
      headers: presigned.headers,
      expiresAt: presigned.expiresAt.toISOString(),
    };
  }

  /** Verifies the uploaded bytes, scans them and publishes the document (or rejects it). */
  async complete(id: string, user: AuthUser): Promise<DocumentView> {
    const doc = await this.getDoc(id);
    if (!(await this.isOwner(user, doc.owner.type, doc.owner.id.toHexString())))
      throw new NotFoundError('Document', id);
    const claimed = await this.documents
      .findOneAndUpdate(
        { _id: doc._id, status: 'PENDING_UPLOAD' },
        { $set: { status: 'SCANNING' } },
        { new: true },
      )
      .lean<DocumentDoc>()
      .exec();
    if (!claimed) {
      if (doc.status === 'PENDING_UPLOAD')
        throw new DomainError('STATE_CONFLICT', 'This upload is already being processed.');
      return toDocumentView(doc);
    }

    const head = await this.storage.head(doc.storageKey);
    if (!head) {
      await this.documents.updateOne({ _id: doc._id }, { $set: { status: 'PENDING_UPLOAD' } });
      throw new DomainError('UPLOAD_NOT_FOUND', 'The file has not finished uploading. Try again.');
    }
    const type = await this.getType(doc.typeCode);
    let outcome: { status: DocumentStatus; reason?: string };
    try {
      if (head.sizeBytes !== doc.sizeBytes || head.sizeBytes > type.maxSizeBytes) {
        outcome = { status: 'REJECTED_TYPE', reason: 'The uploaded file size does not match.' };
      } else {
        const content = await this.storage.getBuffer(doc.storageKey, type.maxSizeBytes);
        const sniffed = sniffMime(content.subarray(0, 16));
        if (!sniffed || sniffed !== doc.mime || !(type.allowedMime as string[]).includes(sniffed)) {
          outcome = {
            status: 'REJECTED_TYPE',
            reason: 'The file content does not match an allowed file type.',
          };
        } else {
          const scan = await this.scanner.scan(content);
          outcome = scan.clean
            ? { status: 'UPLOADED' }
            : { status: 'REJECTED_MALWARE', reason: 'The file failed the security scan.' };
          if (!scan.clean)
            this.logger.warn({ documentId: id, signature: scan.signature }, 'Malware detected in upload');
        }
      }
    } catch (err) {
      await this.documents.updateOne({ _id: doc._id }, { $set: { status: 'PENDING_UPLOAD' } });
      throw err;
    }

    if (outcome.status === 'UPLOADED') {
      const cleanKey = `clean/${doc._id.toHexString()}`;
      await this.storage.move(doc.storageKey, cleanKey);
      await this.documents.updateOne(
        { _id: doc._id },
        { $set: { status: 'UPLOADED', storageKey: cleanKey } },
      );
      // Older versions of the same document are superseded (FR-DOC-07); history is kept.
      await this.documents.updateMany(
        {
          'owner.type': doc.owner.type,
          'owner.id': doc.owner.id,
          typeCode: doc.typeCode,
          _id: { $ne: doc._id },
          status: { $in: ['UPLOADED', 'VERIFIED', 'REJECTED', 'EXPIRED'] },
        },
        { $set: { status: 'SUPERSEDED' } },
      );
    } else {
      await this.storage.delete(doc.storageKey).catch(() => undefined);
      await this.documents.updateOne(
        { _id: doc._id },
        { $set: { status: outcome.status, rejectionReason: outcome.reason } },
      );
    }
    return toDocumentView(await this.getDoc(id), type.name);
  }

  /* ------------------------------------------------------------------ read */

  private async getDoc(id: string): Promise<DocumentDoc> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.documents.findById(id).lean<DocumentDoc>().exec()
      : null;
    if (!doc) throw new NotFoundError('Document', id);
    return doc;
  }

  async get(id: string, user: AuthUser): Promise<DocumentView> {
    const doc = await this.getDoc(id);
    await this.assertCanRead(user, doc);
    return toDocumentView(
      doc,
      (await this.types.findOne({ code: doc.typeCode }).lean<DocumentTypeDoc>().exec())?.name,
    );
  }

  async list(
    ownerType: DocumentOwnerType,
    ownerId: string,
    user: AuthUser,
    includeHistory: boolean,
  ): Promise<DocumentView[]> {
    if (!this.isReviewer(user) && !(await this.isOwner(user, ownerType, ownerId)))
      throw new NotFoundError('Document owner', ownerId);
    return this.listForOwner(ownerType, ownerId, includeHistory);
  }

  /** Internal (no access check): used by verification screens and readiness checks. */
  async listForOwner(
    ownerType: DocumentOwnerType,
    ownerId: string,
    includeHistory = false,
  ): Promise<DocumentView[]> {
    const filter: Record<string, unknown> = {
      'owner.type': ownerType,
      'owner.id': new Types.ObjectId(ownerId),
    };
    if (!includeHistory) filter.status = { $nin: ['SUPERSEDED', 'PENDING_UPLOAD', 'SCANNING'] };
    const [docs, types] = await Promise.all([
      this.documents.find(filter).sort({ typeCode: 1, versionNo: -1 }).lean<DocumentDoc[]>().exec(),
      this.types.find().lean<DocumentTypeDoc[]>().exec(),
    ]);
    const names = new Map(types.map((t) => [t.code, t.name]));
    return docs.map((d) => toDocumentView(d, names.get(d.typeCode)));
  }

  /** Mandatory document types that have no current UPLOADED/VERIFIED document. */
  async missingTypes(
    ownerType: DocumentOwnerType,
    ownerId: string,
    requiredCodes: string[],
  ): Promise<string[]> {
    if (requiredCodes.length === 0) return [];
    const present = await this.documents.distinct('typeCode', {
      'owner.type': ownerType,
      'owner.id': new Types.ObjectId(ownerId),
      typeCode: { $in: requiredCodes },
      status: { $in: ACTIVE_DOCUMENT_STATUSES },
      $or: [{ expiresOn: { $exists: false } }, { expiresOn: { $gte: todayIst() } }],
    });
    return requiredCodes.filter((c) => !present.includes(c));
  }

  /** Required types not yet VERIFIED (approval gate). */
  async unverifiedTypes(
    ownerType: DocumentOwnerType,
    ownerId: string,
    requiredCodes: string[],
  ): Promise<string[]> {
    if (requiredCodes.length === 0) return [];
    const verified = await this.documents.distinct('typeCode', {
      'owner.type': ownerType,
      'owner.id': new Types.ObjectId(ownerId),
      typeCode: { $in: requiredCodes },
      status: 'VERIFIED',
    });
    return requiredCodes.filter((c) => !verified.includes(c));
  }

  /** Ensures a document exists, belongs to the owner, is clean and of the expected type. */
  async assertUsable(
    id: string,
    ownerType: DocumentOwnerType,
    ownerId: string,
    typeCode: string,
    session?: ClientSession,
  ): Promise<void> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.documents.findById(id, undefined, { session }).lean<DocumentDoc>().exec()
      : null;
    if (
      !doc ||
      doc.owner.type !== ownerType ||
      !doc.owner.id.equals(ownerId) ||
      doc.typeCode !== typeCode ||
      !ACTIVE_DOCUMENT_STATUSES.includes(doc.status)
    ) {
      throw new DomainError('DOCUMENT_NOT_CLEAN', 'Attach a successfully uploaded proof document.', [
        { field: 'proofDocId' },
      ]);
    }
  }

  async downloadUrl(
    id: string,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<{ url: string; expiresAt: string; mime: string; fileName: string }> {
    const doc = await this.getDoc(id);
    await this.assertCanRead(user, doc);
    if (
      !['UPLOADED', 'VERIFIED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'].includes(doc.status) ||
      !doc.storageKey.startsWith('clean/')
    ) {
      throw new DomainError('DOCUMENT_NOT_CLEAN', 'This document is not available for download.');
    }
    const ttl = await this.config.get('documents.downloadUrlTtlSeconds');
    const type = await this.types.findOne({ code: doc.typeCode }).lean<DocumentTypeDoc>().exec();
    // Shown in the browser tab, not saved: every stored document is a PDF/JPEG/PNG/WebP whose
    // type was checked by magic bytes when the upload completed.
    const url = await this.storage.presignDownload(doc.storageKey, ttl, {
      fileName: doc.fileName,
      inline: true,
    });
    if (type?.isSensitive) {
      await this.audit.record({
        actor: actorFromUser(user),
        action: 'document.download',
        entityType: 'Document',
        entityId: id,
        after: { typeCode: doc.typeCode, owner: doc.owner.type },
        context: ctx,
      });
    }
    return {
      url,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      mime: doc.mime,
      fileName: doc.fileName,
    };
  }

  /* ------------------------------------------------------------------ review & expiry */

  async review(
    id: string,
    input: DocumentReviewInput,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<DocumentView> {
    const doc = await this.getDoc(id);
    const updated = await this.documents
      .findOneAndUpdate(
        { _id: doc._id, status: { $in: ['UPLOADED', 'VERIFIED', 'REJECTED'] } },
        {
          $set: {
            status: input.decision,
            review: {
              by: user.id,
              at: new Date(),
              decision: input.decision,
              ...(input.comment ? { comment: input.comment } : {}),
            },
          },
        },
        { new: true },
      )
      .lean<DocumentDoc>()
      .exec();
    if (!updated)
      throw new DomainError('INVALID_STATE_TRANSITION', 'Only uploaded documents can be reviewed.');
    await this.audit.record({
      actor: actorFromUser(user),
      action: `document.${input.decision.toLowerCase()}`,
      entityType: 'Document',
      entityId: id,
      before: { status: doc.status },
      after: { status: input.decision },
      reason: input.comment,
      context: ctx,
    });
    return toDocumentView(updated);
  }

  /** Daily job (FR-DOC-06): marks documents past their expiry date as EXPIRED. */
  async expireDue(today = todayIst()): Promise<number> {
    const res = await this.documents.updateMany(
      { status: { $in: ['UPLOADED', 'VERIFIED'] }, expiresOn: { $lt: today } },
      { $set: { status: 'EXPIRED' } },
    );
    if (res.modifiedCount) this.logger.log(`Expired ${res.modifiedCount} documents`);
    return res.modifiedCount;
  }
}
