import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { AppConfig } from '../config/app-config';

export type TxnFn<T> = (session: ClientSession) => Promise<T>;

export interface TxnOptions {
  /** Join an already-open transaction instead of starting a new one. */
  session?: ClientSession;
  maxRetries?: number;
}

interface LabelledError {
  code?: number;
  codeName?: string;
  errorLabels?: string[];
  hasErrorLabel?: (label: string) => boolean;
}

const WRITE_CONFLICT = 112;

function hasLabel(err: unknown, label: string): boolean {
  const e = err as LabelledError | undefined;
  if (!e || typeof e !== 'object') return false;
  if (typeof e.hasErrorLabel === 'function' && e.hasErrorLabel(label)) return true;
  return Array.isArray(e.errorLabels) && e.errorLabels.includes(label);
}

export function isTransientTxnError(err: unknown): boolean {
  const e = err as LabelledError | undefined;
  return (
    hasLabel(err, 'TransientTransactionError') ||
    e?.code === WRITE_CONFLICT ||
    e?.codeName === 'WriteConflict'
  );
}

export function isUnknownCommitResult(err: unknown): boolean {
  return hasLabel(err, 'UnknownTransactionCommitResult');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a unit of work in a MongoDB multi-document transaction (snapshot read concern, majority
 * write concern) and retries the whole unit on transient errors such as WriteConflict, which the
 * allocation person-lock deliberately provokes (ARCHITECTURE §6.3, DATABASE §13).
 *
 * The callback MUST be safe to re-run: it may not perform external side effects (HTTP calls,
 * queue publishes). Use the outbox for those.
 */
@Injectable()
export class TransactionRunner {
  private readonly logger = new Logger(TransactionRunner.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly config: AppConfig,
  ) {}

  async run<T>(fn: TxnFn<T>, options: TxnOptions = {}): Promise<T> {
    if (options.session?.inTransaction()) {
      return fn(options.session);
    }
    const maxRetries = options.maxRetries ?? this.config.env.DB_TXN_MAX_RETRIES;

    for (let attempt = 0; ; attempt += 1) {
      const session = await this.connection.startSession();
      try {
        session.startTransaction({
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        });
        const result = await fn(session);
        await this.commitWithRetry(session, maxRetries);
        return result;
      } catch (err) {
        if (session.inTransaction()) {
          await session.abortTransaction().catch(() => undefined);
        }
        if (isTransientTxnError(err) && attempt < maxRetries) {
          const backoff = Math.min(25 * 2 ** attempt, 500) + Math.floor(Math.random() * 25);
          this.logger.debug(
            `Transient transaction error, retry ${attempt + 1}/${maxRetries} in ${backoff}ms`,
          );
          await sleep(backoff);
          continue;
        }
        throw err;
      } finally {
        await session.endSession();
      }
    }
  }

  private async commitWithRetry(session: ClientSession, maxRetries: number): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await session.commitTransaction();
        return;
      } catch (err) {
        if (isUnknownCommitResult(err) && attempt < maxRetries) continue;
        throw err;
      }
    }
  }
}
