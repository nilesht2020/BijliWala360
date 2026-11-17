import { Global, Injectable, Module } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type FilterQuery, type Model } from 'mongoose';
import type { AuditLogView, AuditQuery, CursorMeta } from '@skillconnect/contracts';
import { DomainError } from '../errors/domain-error';
import type { AuthUser } from '../auth/auth.types';
import { AUDIT_MODEL, type AuditDoc } from '../database/core.schemas';

export interface AuditActor {
  userId?: string;
  userType?: string;
  roleCodes?: string[];
  /** For system-initiated actions, e.g. 'worker:invitation-expiry'. */
  system?: string;
}

export interface AuditContext {
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export interface AuditEntry {
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  isFinancial?: boolean;
  context?: AuditContext;
}

const NON_FINANCIAL_RETENTION_MS = 7 * 365 * 24 * 60 * 60 * 1000;

/** Keys whose values are never written to the audit trail (SRS FR-AUD-01). */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'otp',
  'codeHash',
  'tokenHash',
  'secretEnc',
  'accountEnc',
  'panEnc',
  'numberEnc',
  'idNumber',
  'accountNumber',
  'mfa',
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (typeof (value as { toHexString?: unknown }).toHexString === 'function') {
      return (value as { toHexString: () => string }).toHexString();
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function actorFromUser(user: AuthUser): AuditActor {
  return { userId: user.id, userType: user.userType, roleCodes: user.roleCodes };
}

/** Append-only audit trail. There is deliberately no update or delete API. */
@Injectable()
export class AuditService {
  /**
   * Search (FR-AUD-03), newest first, keyset-paginated on (at, _id) so pages stay stable while new
   * entries are appended.
   */
  async search(q: AuditQuery): Promise<{ items: AuditLogView[]; meta: CursorMeta }> {
    const filter: FilterQuery<AuditDoc> = {};
    if (q.entityType) filter.entityType = q.entityType;
    if (q.entityId) filter.entityId = q.entityId;
    if (q.actorId) filter['actor.userId'] = q.actorId;
    if (q.action) {
      // "user.*" filters by prefix; the prefix is fully escaped before building the regex.
      filter.action = q.action.endsWith('*')
        ? { $regex: `^${escapeRegex(q.action.slice(0, -1))}` }
        : q.action;
    }
    if (q.from || q.to) {
      filter.at = {
        ...(q.from ? { $gte: new Date(q.from) } : {}),
        ...(q.to ? { $lte: new Date(q.to) } : {}),
      };
    }
    if (q.cursor) {
      const [iso, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
      if (!iso || !id || !Types.ObjectId.isValid(id) || Number.isNaN(Date.parse(iso))) {
        throw new DomainError('VALIDATION_FAILED', 'Invalid cursor.');
      }
      const at = new Date(iso);
      filter.$and = [{ $or: [{ at: { $lt: at } }, { at, _id: { $lt: new Types.ObjectId(id) } }] }];
    }
    const docs = await this.audit
      .find(filter)
      .sort({ at: -1, _id: -1 })
      .limit(q.limit + 1)
      .lean<Array<AuditDoc & { _id: Types.ObjectId }>>()
      .exec();
    const page = docs.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((d) => ({
        id: d._id.toHexString(),
        at: d.at.toISOString(),
        actor: {
          ...(d.actor?.userId ? { userId: d.actor.userId } : {}),
          ...(d.actor?.userType ? { userType: d.actor.userType } : {}),
          ...(d.actor?.roleCodes?.length ? { roleCodes: d.actor.roleCodes } : {}),
          ...(d.actor?.system ? { system: d.actor.system } : {}),
        },
        action: d.action,
        entityType: d.entityType,
        entityId: d.entityId,
        ...(d.before !== undefined ? { before: d.before } : {}),
        ...(d.after !== undefined ? { after: d.after } : {}),
        ...(d.reason ? { reason: d.reason } : {}),
        ...(d.requestId ? { requestId: d.requestId } : {}),
        ...(d.ip ? { ip: d.ip } : {}),
        isFinancial: d.isFinancial,
      })),
      meta: {
        nextCursor:
          docs.length > q.limit && last
            ? Buffer.from(`${last.at.toISOString()}|${last._id.toHexString()}`).toString('base64url')
            : null,
      },
    };
  }

  constructor(@InjectModel(AUDIT_MODEL) private readonly audit: Model<AuditDoc>) {}

  async record(entry: AuditEntry, session?: ClientSession): Promise<void> {
    const now = new Date();
    const isFinancial = entry.isFinancial ?? false;
    await this.audit.create(
      [
        {
          at: now,
          actor: entry.actor,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          before: redact(entry.before),
          after: redact(entry.after),
          reason: entry.reason,
          requestId: entry.context?.requestId,
          ip: entry.context?.ip,
          userAgent: entry.context?.userAgent,
          isFinancial,
          ...(isFinancial ? {} : { expireAt: new Date(now.getTime() + NON_FINANCIAL_RETENTION_MS) }),
        },
      ],
      { session },
    );
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditCoreModule {}
