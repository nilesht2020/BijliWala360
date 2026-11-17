/**
 * Quiet hours (FR-NTF-06) are expressed in site-local minutes from midnight and may wrap past
 * midnight (e.g. 21:00 -> 08:00). Returns how long a non-urgent message must wait, in ms.
 */
export interface QuietHours {
  enabled: boolean;
  startMin: number;
  endMin: number;
}

export function minuteOfDayIn(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  return h * 60 + m;
}

export function isWithinQuietHours(minute: number, q: QuietHours): boolean {
  if (!q.enabled || q.startMin === q.endMin) return false;
  return q.startMin < q.endMin
    ? minute >= q.startMin && minute < q.endMin
    : minute >= q.startMin || minute < q.endMin;
}

/** Delay until quiet hours end (0 if not currently quiet). Second precision is not needed. */
export function quietHoursDelayMs(now: Date, q: QuietHours, timeZone = 'Asia/Kolkata'): number {
  const minute = minuteOfDayIn(now, timeZone);
  if (!isWithinQuietHours(minute, q)) return 0;
  const minutesLeft = (q.endMin - minute + 1440) % 1440;
  return minutesLeft * 60_000;
}
