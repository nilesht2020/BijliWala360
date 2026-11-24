import { formatPaise } from '@bijliwala/contracts';

export const DISPLAY_TIME_ZONE = 'Asia/Kolkata';

/** ₹1,23,456.00 from integer paise. */
export const formatMoney = (paise: number | null | undefined): string =>
  paise == null ? '—' : formatPaise(paise);

const dateFormatter = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: DISPLAY_TIME_ZONE,
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
  timeZone: DISPLAY_TIME_ZONE,
});

/** Formats an ISO instant in IST. */
export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? '—' : dateTimeFormatter.format(d);
}

/**
 * Formats either an ISO instant or a site-local calendar date (YYYY-MM-DD). Calendar dates are
 * rendered as-is (no timezone shift), because they already are local dates (DATABASE §1).
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d)));
  }
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? '—' : dateFormatter.format(d);
}

/** 570 -> "09:30" (minutes from local midnight). */
export function formatMinuteOfDay(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "SCREAMING_SNAKE" -> "Screaming snake" for enum labels. */
export function humanize(value: string): string {
  const s = value.replace(/[_.]+/g, ' ').toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** +919812345678 -> "+91 98123 45678" */
export function formatMobile(e164: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}
