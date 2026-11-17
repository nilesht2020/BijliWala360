import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ZodError } from 'zod';
import {
  BUSINESS_CONFIG,
  BUSINESS_CONFIG_KEYS,
  isBusinessConfigKey,
  type BusinessConfigKey,
  type BusinessConfigValue,
} from '@skillconnect/contracts';
import { AuditService, type AuditActor } from '../audit/audit.service';
import { BUSINESS_SETTING_MODEL, type BusinessSettingDoc } from '../database/core.schemas';
import { DomainError } from '../errors/domain-error';
import { zodErrorToDomainError } from '../http/zod';
import { InjectRedis, type RedisClient } from '../redis/redis.module';

const CACHE_PREFIX = 'bcfg:';
const CACHE_TTL_SECONDS = 300;
const HISTORY_LIMIT = 50;

export interface BusinessConfigEntryView {
  key: BusinessConfigKey;
  group: string;
  description: string;
  value: unknown;
  defaultValue: unknown;
  version: number;
  isDefault: boolean;
  updatedAt?: Date;
}

/**
 * Typed business-configuration store (SRS FR-CFG-01/02). Values are validated against the
 * contract registry on write, versioned, audited and cached in Redis (invalidated on change).
 */
@Injectable()
export class BusinessConfigService {
  private readonly logger = new Logger(BusinessConfigService.name);

  constructor(
    @InjectModel(BUSINESS_SETTING_MODEL) private readonly settings: Model<BusinessSettingDoc>,
    @InjectRedis() private readonly redis: RedisClient,
    private readonly audit: AuditService,
  ) {}

  async get<K extends BusinessConfigKey>(key: K): Promise<BusinessConfigValue<K>> {
    const entry = BUSINESS_CONFIG[key];
    try {
      const cached = await this.redis.get(CACHE_PREFIX + key);
      if (cached !== null) return JSON.parse(cached) as BusinessConfigValue<K>;
    } catch (err) {
      this.logger.warn({ err, key }, 'Config cache read failed; falling back to database');
    }

    const doc = await this.settings.findOne({ key }).lean().exec();
    let value: BusinessConfigValue<K>;
    if (doc) {
      const parsed = entry.schema.safeParse(doc.value);
      if (parsed.success) {
        value = parsed.data as BusinessConfigValue<K>;
      } else {
        this.logger.error({ key }, 'Stored config value is invalid; using default');
        value = entry.defaultValue as BusinessConfigValue<K>;
      }
    } else {
      value = entry.defaultValue as BusinessConfigValue<K>;
    }

    await this.redis
      .set(CACHE_PREFIX + key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS)
      .catch(() => undefined);
    return value;
  }

  async list(): Promise<BusinessConfigEntryView[]> {
    const docs = await this.settings
      .find({ key: { $in: BUSINESS_CONFIG_KEYS } })
      .lean()
      .exec();
    const byKey = new Map(docs.map((d) => [d.key, d]));
    return BUSINESS_CONFIG_KEYS.map((key) => {
      const entry = BUSINESS_CONFIG[key];
      const doc = byKey.get(key);
      return {
        key,
        group: entry.group,
        description: entry.description,
        value: doc ? doc.value : entry.defaultValue,
        defaultValue: entry.defaultValue,
        version: doc?.version ?? 0,
        isDefault: !doc,
        updatedAt: (doc as { updatedAt?: Date } | undefined)?.updatedAt,
      };
    });
  }

  /**
   * Updates a key. `expectedVersion` gives optimistic locking (If-Match); 0 means "never set".
   */
  async set(
    key: string,
    rawValue: unknown,
    actor: AuditActor,
    expectedVersion?: number,
  ): Promise<BusinessConfigEntryView> {
    if (!isBusinessConfigKey(key))
      throw new DomainError('CONFIG_KEY_UNKNOWN', `Unknown configuration key ${key}.`);
    const entry = BUSINESS_CONFIG[key];
    let value: unknown;
    try {
      value = entry.schema.parse(rawValue);
    } catch (err) {
      if (err instanceof ZodError) throw zodErrorToDomainError(err);
      throw err;
    }

    const existing = await this.settings.findOne({ key }).lean().exec();
    const currentVersion = existing?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new DomainError('VERSION_MISMATCH', `Configuration ${key} was changed by someone else.`);
    }

    const updatedBy = actor.userId ?? actor.system ?? 'system';
    const now = new Date();
    if (existing) {
      const res = await this.settings.updateOne(
        { key, version: currentVersion },
        {
          $set: { value, updatedBy },
          $inc: { version: 1 },
          $push: {
            history: {
              $each: [
                {
                  value: existing.value,
                  version: currentVersion,
                  updatedBy: existing.updatedBy,
                  updatedAt: now,
                },
              ],
              $slice: -HISTORY_LIMIT,
            },
          },
        },
      );
      if (res.matchedCount === 0)
        throw new DomainError('VERSION_MISMATCH', `Configuration ${key} was changed concurrently.`);
    } else {
      try {
        await this.settings.create({ key, value, version: 1, updatedBy, history: [] });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          throw new DomainError('VERSION_MISMATCH', `Configuration ${key} was changed concurrently.`);
        }
        throw err;
      }
    }

    await this.redis.del(CACHE_PREFIX + key).catch(() => undefined);
    await this.audit.record({
      actor,
      action: 'config.update',
      entityType: 'BusinessSetting',
      entityId: key,
      before: existing
        ? { value: existing.value, version: currentVersion }
        : { value: entry.defaultValue, version: 0 },
      after: { value, version: currentVersion + 1 },
    });

    return {
      key,
      group: entry.group,
      description: entry.description,
      value,
      defaultValue: entry.defaultValue,
      version: currentVersion + 1,
      isDefault: false,
      updatedAt: now,
    };
  }
}

@Global()
@Module({ providers: [BusinessConfigService], exports: [BusinessConfigService] })
export class BusinessConfigModule {}
