import { Global, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import { AppConfig } from '../config/app-config';

/** Queue names used across the system. Add new queues here, never as string literals elsewhere. */
export const QUEUES = {
  DOMAIN_EVENTS: 'domain-events',
  NOTIFICATIONS: 'notifications',
  WEBHOOKS: 'webhooks',
  DOCUMENT_SCAN: 'document-scan',
  SCHEDULED: 'scheduled',
  DEAD_LETTER: 'dead-letter',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** The part of a job our processors use; identical in both queue modes. */
export interface QueueJob<T> {
  id?: string;
  name: string;
  data: T;
  attemptsMade: number;
}
export type JobProcessor<T> = (job: QueueJob<T>) => Promise<unknown>;

function connectionFromUrl(url: string): {
  host: string;
  port: number;
  password?: string;
  db?: number;
  tls?: object;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname && u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

interface PendingInline {
  name: string;
  data: unknown;
  opts: JobsOptions;
}

/**
 * Job queues (ARCHITECTURE §5 `queue/`) with two modes:
 *  - `queue` (default, production): BullMQ on Redis; jobs survive restarts and run in the worker process;
 *  - `inline` (development without Redis): jobs run in-process with the same retry/backoff and
 *    jobId de-duplication semantics, so every flow can be exercised on a laptop. Not durable.
 * Jobs that exhaust their attempts are reported to the dead-letter queue / log.
 */
@Injectable()
export class QueueRegistry implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueRegistry.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private readonly connection: ReturnType<typeof connectionFromUrl>;
  readonly inline: boolean;

  // inline mode state
  private readonly processors = new Map<string, JobProcessor<unknown>>();
  private readonly pending = new Map<string, PendingInline[]>();
  private readonly seenJobIds = new Map<string, Set<string>>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(config: AppConfig) {
    this.connection = connectionFromUrl(config.env.REDIS_URL);
    this.inline = config.env.QUEUE_MODE === 'inline';
  }

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T extends object>(
    name: QueueName,
    jobName: string,
    data: T,
    opts: JobsOptions = {},
  ): Promise<void> {
    if (!this.inline) {
      await this.queue(name).add(jobName, data, opts);
      return;
    }
    if (opts.jobId) {
      const seen = this.seenJobIds.get(name) ?? new Set<string>();
      if (seen.has(opts.jobId)) return; // same de-duplication as BullMQ jobId
      seen.add(opts.jobId);
      if (seen.size > 50_000) seen.delete(seen.values().next().value as string);
      this.seenJobIds.set(name, seen);
    }
    const processor = this.processors.get(name);
    if (!processor) {
      this.pending.set(name, [...(this.pending.get(name) ?? []), { name: jobName, data, opts }]);
      return;
    }
    this.runInline(name, processor, { name: jobName, data, opts }, opts.delay ?? 0, 0);
  }

  registerWorker<T>(name: QueueName, processor: JobProcessor<T>, concurrency = 5): void {
    if (this.inline) {
      this.processors.set(name, processor as JobProcessor<unknown>);
      for (const job of this.pending.get(name) ?? []) {
        this.runInline(name, processor as JobProcessor<unknown>, job, job.opts.delay ?? 0, 0);
      }
      this.pending.delete(name);
      return;
    }
    const worker = new Worker<T>(
      name,
      async (job) =>
        processor({ id: job.id, name: job.name, data: job.data, attemptsMade: job.attemptsMade }),
      { connection: this.connection, concurrency },
    );
    worker.on('failed', (job, err) => {
      if (!job) return;
      const maxAttempts = job.opts.attempts ?? 1;
      this.logger.warn(
        { queue: name, jobId: job.id, attempt: job.attemptsMade, err: err.message },
        'Job failed',
      );
      if (job.attemptsMade >= maxAttempts && name !== QUEUES.DEAD_LETTER) {
        void this.add(QUEUES.DEAD_LETTER, `${name}:${job.name}`, {
          queue: name,
          jobId: job.id,
          data: job.data,
          error: err.message,
        }).catch(() => undefined);
      }
    });
    this.workers.push(worker as Worker);
  }

  /** Runs `jobName` every `everyMs` (BullMQ repeatable job, or a timer in inline mode). */
  async schedule(name: QueueName, jobName: string, everyMs: number, data: object = {}): Promise<void> {
    if (!this.inline) {
      await this.queue(name).add(jobName, data, { repeat: { every: everyMs }, jobId: `repeat:${jobName}` });
      return;
    }
    const timer = setInterval(() => {
      const processor = this.processors.get(name);
      if (processor) this.runInline(name, processor, { name: jobName, data, opts: { attempts: 1 } }, 0, 0);
    }, everyMs);
    timer.unref();
    this.timers.add(timer);
  }

  private runInline(
    name: string,
    processor: JobProcessor<unknown>,
    job: PendingInline,
    delayMs: number,
    attempt: number,
  ): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      processor({ id: job.opts.jobId, name: job.name, data: job.data, attemptsMade: attempt }).catch(
        (err: unknown) => {
          const maxAttempts = job.opts.attempts ?? DEFAULT_JOB_OPTIONS.attempts ?? 1;
          const message = err instanceof Error ? err.message : String(err);
          if (attempt + 1 < maxAttempts) {
            const backoff = Math.min(1000 * 2 ** attempt, 30_000);
            this.logger.warn(
              { queue: name, job: job.name, attempt: attempt + 1, err: message },
              `Job failed; retrying in ${backoff}ms`,
            );
            this.runInline(name, processor, job, backoff, attempt + 1);
          } else {
            this.logger.error(
              { queue: name, job: job.name, data: job.data, err: message },
              'Job failed permanently (dead letter)',
            );
          }
        },
      );
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}

@Global()
@Module({ providers: [QueueRegistry], exports: [QueueRegistry] })
export class QueueModule {}
