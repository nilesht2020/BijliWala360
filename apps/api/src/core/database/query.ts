import type { FilterQuery, Model } from 'mongoose';
import type { PageMeta } from '@bijliwala/contracts';

/** Escapes user text for a case-insensitive `$regex` search (no regex injection / ReDoS). */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsText(value: string): { $regex: string; $options: string } {
  return { $regex: escapeRegex(value), $options: 'i' };
}

/** Offset pagination over a lean query: returns the page of documents and its meta. */
export async function findPage<T>(
  model: Model<T>,
  filter: FilterQuery<T>,
  page: { page: number; pageSize: number },
  sort: Record<string, 1 | -1> = { createdAt: -1, _id: -1 },
): Promise<{ docs: T[]; meta: PageMeta }> {
  const [docs, total] = await Promise.all([
    model
      .find(filter)
      .sort(sort)
      .skip((page.page - 1) * page.pageSize)
      .limit(page.pageSize)
      .lean<T[]>()
      .exec(),
    model.countDocuments(filter).exec(),
  ]);
  return { docs, meta: { page: page.page, pageSize: page.pageSize, total } };
}

/** Today's calendar date in a timezone (default IST) as YYYY-MM-DD. */
export function todayIn(timeZone = 'Asia/Kolkata', now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
