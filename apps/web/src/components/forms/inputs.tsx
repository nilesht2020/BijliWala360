import { forwardRef, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/* ---------------------------------------------------------------------------------------------- */
/* MoneyInput: edits rupees, emits integer paise (BR-FIN-05).                                     */
/* ---------------------------------------------------------------------------------------------- */

export function paiseToInput(paise: number | null | undefined): string {
  if (paise == null) return '';
  const rupees = Math.floor(paise / 100);
  const fraction = paise % 100;
  return fraction === 0 ? String(rupees) : `${rupees}.${String(fraction).padStart(2, '0')}`;
}

/** Parses "1,234.5" -> 123450. Returns null for empty input, NaN for invalid input. */
export function inputToPaise(text: string): number | null {
  const cleaned = text.replace(/[,\s₹]/g, '');
  if (cleaned === '') return null;
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return Number.NaN;
  const [whole, frac = ''] = cleaned.split('.') as [string, string?];
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export interface MoneyInputProps {
  id?: string;
  value: number | null | undefined;
  onChange: (paise: number | null) => void;
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(
  ({ value, onChange, onBlur, className, placeholder = '0.00', ...rest }, ref) => {
    const [text, setText] = useState(() => paiseToInput(value));
    const lastEmitted = useRef<number | null | undefined>(value);

    // Sync when the value is changed from outside (form reset etc.).
    useEffect(() => {
      if (value !== lastEmitted.current) {
        setText(paiseToInput(value));
        lastEmitted.current = value;
      }
    }, [value]);

    return (
      <div className={cn('relative', className)}>
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
          ₹
        </span>
        <Input
          ref={ref}
          inputMode="decimal"
          className="tabular pl-7"
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            if (!/^[\d,.\s]*$/.test(next)) return;
            setText(next);
            const paise = inputToPaise(next);
            if (paise === null || !Number.isNaN(paise)) {
              lastEmitted.current = paise;
              onChange(paise);
            }
          }}
          onBlur={() => {
            const paise = inputToPaise(text);
            if (paise !== null && !Number.isNaN(paise)) setText(paiseToInput(paise));
            onBlur?.();
          }}
          {...rest}
        />
      </div>
    );
  },
);
MoneyInput.displayName = 'MoneyInput';

/* ---------------------------------------------------------------------------------------------- */
/* PhoneInput: Indian mobile, emits E.164 (+91XXXXXXXXXX).                                         */
/* ---------------------------------------------------------------------------------------------- */

export interface PhoneInputProps {
  id?: string;
  value: string | undefined;
  onChange: (e164: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  className?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

export const PhoneInput = forwardRef<HTMLInputElement, PhoneInputProps>(
  ({ value, onChange, className, ...rest }, ref) => {
    const local = (value ?? '').replace(/^\+91/, '');
    return (
      <div className={cn('flex', className)}>
        <span className="inline-flex items-center rounded-l-lg border border-r-0 border-input bg-muted px-3 text-sm text-muted-foreground">
          +91
        </span>
        <Input
          ref={ref}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={10}
          placeholder="98765 43210"
          className="rounded-l-none"
          value={local}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
            onChange(digits ? `+91${digits}` : '');
          }}
          {...rest}
        />
      </div>
    );
  },
);
PhoneInput.displayName = 'PhoneInput';

/* ---------------------------------------------------------------------------------------------- */
/* OtpInput: N single-digit boxes with paste, backspace and arrow-key support.                    */
/* ---------------------------------------------------------------------------------------------- */

export function OtpInput({
  length = 6,
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus,
  'aria-invalid': invalid,
}: {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  'aria-invalid'?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');

  const update = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
  };

  const focus = (i: number) => refs.current[Math.max(0, Math.min(length - 1, i))]?.focus();

  const handleKey = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[i]) {
        update(value.slice(0, i) + value.slice(i + 1));
      } else if (i > 0) {
        update(value.slice(0, i - 1) + value.slice(i));
        focus(i - 1);
      }
    } else if (e.key === 'ArrowLeft') {
      focus(i - 1);
    } else if (e.key === 'ArrowRight') {
      focus(i + 1);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '');
    if (pasted) {
      update(pasted);
      focus(pasted.length);
    }
  };

  return (
    <div className="flex gap-2" role="group" aria-label="One-time password">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          aria-label={`Digit ${i + 1}`}
          aria-invalid={invalid}
          className={cn(
            'h-12 w-11 rounded-lg border border-input bg-background text-center text-lg font-semibold tabular',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive',
          )}
          onKeyDown={handleKey(i)}
          onPaste={handlePaste}
          onChange={(e) => {
            const ch = e.target.value.replace(/\D/g, '').slice(-1);
            if (!ch) return;
            // Digits are contiguous: typing into a box past the end appends instead of leaving gaps.
            const pos = Math.min(i, value.length);
            update(value.slice(0, pos) + ch + value.slice(pos + 1));
            focus(pos + 1);
          }}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* DateRangePicker: two native date inputs emitting site-local YYYY-MM-DD strings.                */
/* ---------------------------------------------------------------------------------------------- */

export interface DateRange {
  from: string;
  to: string;
}

export function DateRangePicker({
  value,
  onChange,
  min,
  max,
  idPrefix = 'range',
}: {
  value: Partial<DateRange>;
  onChange: (value: Partial<DateRange>) => void;
  min?: string;
  max?: string;
  idPrefix?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <label
        className="flex flex-col gap-1 text-xs font-medium text-muted-foreground"
        htmlFor={`${idPrefix}-from`}
      >
        From
        <Input
          id={`${idPrefix}-from`}
          type="date"
          value={value.from ?? ''}
          min={min}
          max={value.to ?? max}
          onChange={(e) => onChange({ ...value, from: e.target.value || undefined })}
        />
      </label>
      <label
        className="flex flex-col gap-1 text-xs font-medium text-muted-foreground"
        htmlFor={`${idPrefix}-to`}
      >
        To
        <Input
          id={`${idPrefix}-to`}
          type="date"
          value={value.to ?? ''}
          min={value.from ?? min}
          max={max}
          onChange={(e) => onChange({ ...value, to: e.target.value || undefined })}
        />
      </label>
    </div>
  );
}
