import { LocateFixed } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Control, FieldPath, FieldValues } from 'react-hook-form';
import {
  INDIAN_STATES,
  type BillUnit,
  type JobPositionView,
  type QuotationView,
  type Shift,
} from '@bijliwala/contracts';
import { FormField } from '@/components/forms/form-field';
import { PhoneInput } from '@/components/forms/inputs';
import { Button } from '@/components/ui/button';
import {
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/primitives';
import { formatDate, formatMinuteOfDay, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const UNIT_LABELS: Record<BillUnit, string> = {
  HOUR: 'hour',
  DAY: 'day',
  MONTH: 'month',
  FIXED: 'job',
};

export function formatShift(shift: Shift): string {
  const overnight = shift.endMin < shift.startMin;
  return `${formatMinuteOfDay(shift.startMin)}–${formatMinuteOfDay(shift.endMin)}${overnight ? ' (overnight)' : ''}`;
}

export function formatSchedule(s: {
  startDate: string;
  endDate?: string | undefined;
  weekdays: number[];
}): string {
  const days = s.weekdays.length === 7 ? 'every day' : s.weekdays.map((d) => WEEKDAY_LABELS[d]).join(', ');
  return `${formatDate(s.startDate)}${s.endDate ? ` – ${formatDate(s.endDate)}` : ' onwards'} · ${days}`;
}

/* ---------------------------------------------------------------- inputs */

/** GST state picker: emits the 2-digit code and the state's name (both stored on the address). */
export function StateSelect({
  value,
  onChange,
  ...a
}: {
  value: string | undefined;
  onChange: (code: string, name: string) => void;
  id?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  return (
    <Select
      {...a}
      value={value ?? ''}
      onChange={(e) => {
        const s = INDIAN_STATES.find((x) => x.code === e.target.value);
        if (s) onChange(s.code, s.name);
      }}
    >
      <option value="" disabled>
        Choose a state
      </option>
      {INDIAN_STATES.map((s) => (
        <option key={s.code} value={s.code}>
          {s.name}
        </option>
      ))}
    </Select>
  );
}

/** Address with GST state code, bound to `${prefix}.*` of a React Hook Form form. */
export function GstAddressFields<T extends FieldValues>({
  control,
  prefix,
  setValue,
  label = 'Address',
}: {
  control: Control<T>;
  prefix: string;
  setValue: (name: FieldPath<T>, value: never) => void;
  label?: string;
}) {
  const p = (k: string) => `${prefix}.${k}` as FieldPath<T>;
  return (
    <>
      <FormField
        control={control}
        name={p('line1')}
        label={label}
        required
        className="sm:col-span-2"
        render={(f, a) => <Input {...a} {...f} value={f.value ?? ''} />}
      />
      <FormField
        control={control}
        name={p('city')}
        label="City"
        required
        render={(f, a) => <Input {...a} {...f} value={f.value ?? ''} />}
      />
      <FormField
        control={control}
        name={p('stateCode')}
        label="State"
        required
        render={(f, a) => (
          <StateSelect
            {...a}
            value={f.value}
            onChange={(code, name) => {
              f.onChange(code);
              setValue(p('state'), name as never);
            }}
          />
        )}
      />
      <FormField
        control={control}
        name={p('pincode')}
        label="Pincode"
        required
        render={(f, a) => <Input {...a} {...f} value={f.value ?? ''} inputMode="numeric" maxLength={6} />}
      />
    </>
  );
}

export function WeekdayPicker({
  value,
  onChange,
  id,
}: {
  value: number[];
  onChange: (v: number[]) => void;
  id?: string;
}) {
  return (
    <div id={id} role="group" aria-label="Working days" className="flex flex-wrap gap-1.5">
      {WEEKDAY_LABELS.map((label, d) => {
        const on = value.includes(d);
        return (
          <button
            key={label}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b))}
            className={cn(
              'h-9 min-w-11 rounded-lg border px-2 text-sm font-medium transition-colors',
              on ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-accent',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** <input type="time"> bound to minutes from midnight. */
export function TimeInput({
  value,
  onChange,
  ...a
}: {
  value: number | undefined;
  onChange: (min: number) => void;
  id?: string;
  'aria-invalid'?: boolean;
  'aria-label'?: string;
}) {
  return (
    <Input
      {...a}
      type="time"
      value={value === undefined ? '' : formatMinuteOfDay(value)}
      onChange={(e) => {
        const [h, m] = e.target.value.split(':').map(Number);
        if (h !== undefined && m !== undefined && !Number.isNaN(h) && !Number.isNaN(m)) onChange(h * 60 + m);
      }}
    />
  );
}

/** Lat/lng inputs with a "use my location" button (a map picker can replace this later). */
export function LocationFields<T extends FieldValues>({
  control,
  prefix,
  setValue,
}: {
  control: Control<T>;
  prefix: string;
  setValue: (name: FieldPath<T>, value: never) => void;
}) {
  const [locating, setLocating] = useState(false);
  const p = (k: string) => `${prefix}.${k}` as FieldPath<T>;
  const num = (v: string) => (v === '' ? undefined : Number(v));
  return (
    <>
      <FormField
        control={control}
        name={p('lat')}
        label="Latitude"
        required
        render={(f, a) => (
          <Input
            {...a}
            inputMode="decimal"
            value={f.value ?? ''}
            onChange={(e) => f.onChange(num(e.target.value))}
          />
        )}
      />
      <FormField
        control={control}
        name={p('lng')}
        label="Longitude"
        required
        render={(f, a) => (
          <Input
            {...a}
            inputMode="decimal"
            value={f.value ?? ''}
            onChange={(e) => f.onChange(num(e.target.value))}
          />
        )}
      />
      <div className="sm:col-span-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={locating}
          onClick={() => {
            if (!navigator.geolocation) return;
            setLocating(true);
            navigator.geolocation.getCurrentPosition(
              (pos) => {
                setValue(p('lat'), Number(pos.coords.latitude.toFixed(6)) as never);
                setValue(p('lng'), Number(pos.coords.longitude.toFixed(6)) as never);
                setLocating(false);
              },
              () => setLocating(false),
              { timeout: 10_000 },
            );
          }}
        >
          <LocateFixed aria-hidden /> Use my current location
        </Button>
      </div>
    </>
  );
}

export function ContactFields<T extends FieldValues>({
  control,
  prefix,
}: {
  control: Control<T>;
  prefix: string;
}) {
  const p = (k: string) => `${prefix}.${k}` as FieldPath<T>;
  return (
    <>
      <FormField
        control={control}
        name={p('name')}
        label="Site contact"
        required
        render={(f, a) => <Input {...a} {...f} value={f.value ?? ''} />}
      />
      <FormField
        control={control}
        name={p('mobile')}
        label="Contact mobile"
        required
        render={(f, a) => <PhoneInput {...a} value={f.value} onChange={f.onChange} onBlur={f.onBlur} />}
      />
    </>
  );
}

/* ---------------------------------------------------------------- read-only renderers */

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

/** The commercial part of a quotation, shared by the company view and the admin builder preview. */
export function QuotationDocument({ q, showPayRate = false }: { q: QuotationView; showPayRate?: boolean }) {
  const rows: Array<[string, number, boolean?]> = [['Subtotal', q.subtotalPaise]];
  if (q.discountPaise > 0) rows.push(['Discount', -q.discountPaise]);
  rows.push(['Taxable value', q.taxablePaise]);
  if (q.tax.type === 'INTRA') rows.push(['CGST', q.tax.cgstPaise], ['SGST', q.tax.sgstPaise]);
  else rows.push(['IGST', q.tax.igstPaise]);
  rows.push(['Total', q.totalPaise, true]);
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead>Quantity</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              {showPayRate && <TableHead className="text-right">Pay rate</TableHead>}
              <TableHead className="text-right">GST</TableHead>
              <TableHead className="text-right">Taxable</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.lines.map((l) => (
              <TableRow key={l.lineId}>
                <TableCell>
                  <div className="font-medium">{l.description}</div>
                  <div className="text-xs text-muted-foreground">
                    {l.skillName} · SAC {l.sacCode}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {l.headcount} × {l.quantity} {UNIT_LABELS[l.unit]}
                  {l.quantity === 1 ? '' : 's'}
                </TableCell>
                <TableCell className="tabular whitespace-nowrap text-right">
                  {formatMoney(l.ratePaise)}/{UNIT_LABELS[l.unit]}
                </TableCell>
                {showPayRate && (
                  <TableCell className="tabular text-right">
                    {l.payRatePaise === undefined ? '—' : formatMoney(l.payRatePaise)}
                  </TableCell>
                )}
                <TableCell className="tabular text-right">{l.gstRateBp / 100}%</TableCell>
                <TableCell className="tabular text-right">{formatMoney(l.taxablePaise)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
        {rows.map(([label, amount, strong]) => (
          <div
            key={label}
            className={cn('flex justify-between gap-4', strong && 'border-t pt-2 text-base font-semibold')}
          >
            <dt>{label}</dt>
            <dd className="tabular">{amount < 0 ? `− ${formatMoney(-amount)}` : formatMoney(amount)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Place of supply: {q.placeOfSupply.stateName} ({q.placeOfSupply.stateCode}) ·{' '}
        {q.tax.type === 'INTRA' ? 'intra-state supply (CGST + SGST)' : 'inter-state supply (IGST)'}
      </p>
    </div>
  );
}

export function PositionsTable({
  positions,
  admin = false,
}: {
  positions: JobPositionView[];
  admin?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Position</TableHead>
            <TableHead>Shift</TableHead>
            <TableHead className="text-right">Required</TableHead>
            {admin && <TableHead className="text-right">Held</TableHead>}
            <TableHead className="text-right">Confirmed</TableHead>
            {admin && <TableHead className="text-right">Open</TableHead>}
            <TableHead className="text-right">Bill rate</TableHead>
            {admin && <TableHead className="text-right">Pay rate</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                <div className="font-medium">{p.title}</div>
                <div className="text-xs text-muted-foreground">
                  {p.skillName}
                  {p.minExperienceYears > 0 ? ` · ${p.minExperienceYears}+ yrs` : ''}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap">{formatShift(p.shift)}</TableCell>
              <TableCell className="tabular text-right">{p.required}</TableCell>
              {admin && <TableCell className="tabular text-right">{p.held}</TableCell>}
              <TableCell className="tabular text-right">{p.confirmed}</TableCell>
              {admin && <TableCell className="tabular text-right">{p.available}</TableCell>}
              <TableCell className="tabular whitespace-nowrap text-right">
                {formatMoney(p.billRatePaise)}/{UNIT_LABELS[p.billUnit]}
              </TableCell>
              {admin && (
                <TableCell className="tabular text-right">
                  {p.payRatePaise === undefined ? '—' : formatMoney(p.payRatePaise)}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Progress of staffing: confirmed of required. */
export function StaffingBar({ confirmed, required }: { confirmed: number; required: number }) {
  const pct = required === 0 ? 0 : Math.round((confirmed / required) * 100);
  return (
    <div className="flex items-center gap-2" aria-label={`${confirmed} of ${required} staffed`}>
      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular text-xs text-muted-foreground">
        {confirmed}/{required}
      </span>
    </div>
  );
}
