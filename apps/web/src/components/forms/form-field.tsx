import { useId, type ReactElement, type ReactNode } from 'react';
import {
  Controller,
  type Control,
  type ControllerRenderProps,
  type FieldPath,
  type FieldValues,
  type UseFormSetError,
} from 'react-hook-form';
import type { ApiErrorDetail } from '@skillconnect/contracts';
import { Label } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export interface FieldA11yProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby'?: string;
}

/**
 * Wraps a React Hook Form controller with label, hint and error message, and wires the
 * accessibility attributes (WCAG 2.1 AA, SRS §10.7).
 */
export function FormField<T extends FieldValues, N extends FieldPath<T>>({
  control,
  name,
  label,
  hint,
  required,
  className,
  render,
}: {
  control: Control<T>;
  name: N;
  label: string;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  render: (field: ControllerRenderProps<T, N>, a11y: FieldA11yProps) => ReactElement;
}) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const errorId = fieldState.error ? `${id}-error` : undefined;
        const hintId = hint ? `${id}-hint` : undefined;
        const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
        return (
          <div className={cn('flex flex-col gap-1.5', className)}>
            <Label htmlFor={id}>
              {label}
              {required && (
                <span className="ml-0.5 text-destructive" aria-hidden>
                  *
                </span>
              )}
            </Label>
            {render(field, {
              id,
              'aria-invalid': !!fieldState.error,
              ...(describedBy ? { 'aria-describedby': describedBy } : {}),
            })}
            {hint && !fieldState.error && (
              <p id={hintId} className="text-xs text-muted-foreground">
                {hint}
              </p>
            )}
            {fieldState.error && (
              <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
                {fieldState.error.message}
              </p>
            )}
          </div>
        );
      }}
    />
  );
}

/**
 * Maps server-side validation details (`error.details[].path`) onto form fields. Returns true if
 * at least one field error was applied (ARCHITECTURE §8.2).
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
): boolean {
  if (!(error instanceof ApiError) || !error.isValidation) return false;
  let applied = false;
  for (const detail of error.details as ApiErrorDetail[]) {
    const path = detail.path ?? detail.field;
    if (typeof path === 'string' && path.length > 0) {
      setError(path as FieldPath<T>, { type: 'server', message: detail.message ?? error.message });
      applied = true;
    }
  }
  return applied;
}
