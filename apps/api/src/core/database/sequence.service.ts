import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { COUNTER_MODEL } from './core.schemas';

interface CounterDoc {
  _id: string;
  seq: number;
}

/**
 * Atomic counters for human-readable numbers (job, invoice, quotation...). When called inside a
 * transaction the increment rolls back with it, which keeps invoice series gap-free (FR-INVC-02).
 */
@Injectable()
export class SequenceService {
  constructor(@InjectModel(COUNTER_MODEL) private readonly counters: Model<CounterDoc>) {}

  async next(name: string, session?: ClientSession): Promise<number> {
    const doc = await this.counters
      .findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, new: true, session })
      .lean<CounterDoc>()
      .exec();
    return doc.seq;
  }

  /** e.g. formatted('job', 'JOB', 6) -> "JOB-000042" */
  async formatted(name: string, prefix: string, width = 6, session?: ClientSession): Promise<string> {
    const seq = await this.next(name, session);
    return `${prefix}-${String(seq).padStart(width, '0')}`;
  }
}

/** Indian financial year label for a date, e.g. 2026-11-13 -> "2026-27". */
export function financialYearOf(date: Date, timeZone = 'Asia/Kolkata'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
