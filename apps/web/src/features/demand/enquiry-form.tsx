import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { useFieldArray, useForm, type Resolver } from 'react-hook-form';
import { enquiryCreateSchema, publicEnquirySchema, type SiteView } from '@skillconnect/contracts';
import { applyServerErrors, FormField } from '@/components/forms/form-field';
import { MoneyInput, PhoneInput } from '@/components/forms/inputs';
import { Button } from '@/components/ui/button';
import { Alert, Input, Label, Select, Textarea } from '@/components/ui/primitives';
import { useCategories, useSkills } from '@/features/providers/api';
import { toApiError } from '@/lib/api-client';
import { TimeInput, WeekdayPicker } from './components';

export interface EnquiryFormValues {
  categoryId: string;
  siteId?: string;
  lines: Array<{ skillId: string; headcount: number; minExperienceYears?: number | undefined }>;
  schedule: {
    startDate: string;
    endDate?: string | undefined;
    weekdays: number[];
    shift: { startMin: number; endMin: number };
  };
  description: string;
  budgetPaise?: number | undefined;
  lead?: { name: string; companyName: string; mobile: string; email?: string | undefined; city: string };
  website?: string;
}

/**
 * Enquiry form (FR-ENQ-01). `company` mode asks for one of the company's sites; `public` mode asks
 * for the visitor's contact details instead and carries a hidden honeypot field.
 */
export function EnquiryForm({
  mode,
  sites = [],
  submitLabel = 'Send enquiry',
  pending,
  error,
  onSubmit,
}: {
  mode: 'company' | 'public';
  sites?: SiteView[];
  submitLabel?: string;
  pending?: boolean;
  error?: unknown;
  onSubmit: (values: EnquiryFormValues, setError: (e: unknown) => void) => void;
}) {
  const categories = useCategories();
  const skills = useSkills();
  const form = useForm<EnquiryFormValues>({
    resolver: zodResolver(
      mode === 'company' ? enquiryCreateSchema : publicEnquirySchema,
    ) as unknown as Resolver<EnquiryFormValues>,
    defaultValues: {
      categoryId: '',
      ...(mode === 'company'
        ? { siteId: sites[0]?.id ?? '' }
        : { lead: { name: '', companyName: '', mobile: '', city: '' } }),
      lines: [{ skillId: '', headcount: 1 }],
      schedule: { startDate: '', weekdays: [1, 2, 3, 4, 5, 6], shift: { startMin: 9 * 60, endMin: 18 * 60 } },
      description: '',
    },
  });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const allCategories = categories.data ?? [];
  const apiError = error ? toApiError(error) : null;

  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={form.handleSubmit((v) => onSubmit(v, (e) => applyServerErrors(e, form.setError)))}
    >
      {mode === 'public' && (
        <>
          <FormField
            control={form.control}
            name="lead.name"
            label="Your name"
            required
            render={(f, a) => <Input {...a} {...f} value={f.value ?? ''} autoComplete="name" />}
          />
          <FormField
            control={form.control}
            name="lead.companyName"
            label="Company"
            required
            render={(f, a) => <Input {...a} {...f} value={f.value ?? ''} autoComplete="organization" />}
          />
          <FormField
            control={form.control}
            name="lead.mobile"
            label="Mobile"
            required
            render={(f, a) => <PhoneInput {...a} value={f.value} onChange={f.onChange} onBlur={f.onBlur} />}
          />
          <FormField
            control={form.control}
            name="lead.email"
            label="Email"
            render={(f, a) => (
              <Input
                {...a}
                {...f}
                type="email"
                value={f.value ?? ''}
                onChange={(e) => f.onChange(e.target.value || undefined)}
                autoComplete="email"
              />
            )}
          />
          <FormField
            control={form.control}
            name="lead.city"
            label="City"
            required
            render={(f, a) => <Input {...a} {...f} value={f.value ?? ''} />}
          />
          {/* Honeypot: hidden from people, tempting for bots. */}
          <div aria-hidden className="absolute -left-[10000px] h-0 w-0 overflow-hidden">
            <label>
              Website
              <input tabIndex={-1} autoComplete="off" {...form.register('website')} />
            </label>
          </div>
        </>
      )}

      <FormField
        control={form.control}
        name="categoryId"
        label="Service"
        required
        render={(f, a) => (
          <Select {...a} value={f.value} onChange={f.onChange}>
            <option value="" disabled>
              Choose a service
            </option>
            {allCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.level > 1 ? '— '.repeat(c.level - 1) : ''}
                {c.name}
              </option>
            ))}
          </Select>
        )}
      />

      {mode === 'company' && (
        <FormField
          control={form.control}
          name="siteId"
          label="Site"
          required
          render={(f, a) => (
            <Select {...a} value={f.value ?? ''} onChange={f.onChange}>
              <option value="" disabled>
                Choose a site
              </option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.address.city}
                </option>
              ))}
            </Select>
          )}
        />
      )}

      <fieldset className="space-y-3 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">People needed</legend>
        {lines.fields.map((field, i) => (
          <div
            key={field.id}
            className="grid grid-cols-[1fr_5.5rem_auto] items-end gap-2 sm:grid-cols-[1fr_6rem_8rem_auto]"
          >
            <FormField
              control={form.control}
              name={`lines.${i}.skillId`}
              label="Skill"
              required
              render={(f, a) => (
                <Select {...a} value={f.value} onChange={f.onChange}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {(skills.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            />
            <FormField
              control={form.control}
              name={`lines.${i}.headcount`}
              label="People"
              required
              render={(f, a) => (
                <Input
                  {...a}
                  type="number"
                  min={1}
                  value={f.value ?? ''}
                  onChange={(e) => f.onChange(e.target.valueAsNumber)}
                />
              )}
            />
            <FormField
              control={form.control}
              name={`lines.${i}.minExperienceYears`}
              label="Min. experience (yrs)"
              className="hidden sm:flex"
              render={(f, a) => (
                <Input
                  {...a}
                  type="number"
                  min={0}
                  value={f.value ?? ''}
                  onChange={(e) =>
                    f.onChange(Number.isNaN(e.target.valueAsNumber) ? undefined : e.target.valueAsNumber)
                  }
                />
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove skill"
              disabled={lines.fields.length === 1}
              onClick={() => lines.remove(i)}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
        {form.formState.errors.lines?.root?.message && (
          <p role="alert" className="text-xs font-medium text-destructive">
            {form.formState.errors.lines.root.message}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => lines.append({ skillId: '', headcount: 1 })}
          disabled={lines.fields.length >= 20}
        >
          <Plus aria-hidden /> Add another skill
        </Button>
      </fieldset>

      <FormField
        control={form.control}
        name="schedule.startDate"
        label="Start date"
        required
        render={(f, a) => <Input {...a} type="date" {...f} value={f.value ?? ''} />}
      />
      <FormField
        control={form.control}
        name="schedule.endDate"
        label="End date"
        hint="Leave empty if ongoing"
        render={(f, a) => (
          <Input
            {...a}
            type="date"
            value={f.value ?? ''}
            onChange={(e) => f.onChange(e.target.value || undefined)}
          />
        )}
      />
      <FormField
        control={form.control}
        name="schedule.weekdays"
        label="Working days"
        required
        className="sm:col-span-2"
        render={(f, a) => <WeekdayPicker id={a.id} value={f.value ?? []} onChange={f.onChange} />}
      />
      <div className="grid grid-cols-2 gap-3 sm:col-span-2 sm:max-w-sm">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shift-start">Shift starts</Label>
          <TimeInput
            id="shift-start"
            value={form.watch('schedule.shift.startMin')}
            onChange={(v) => form.setValue('schedule.shift.startMin', v, { shouldValidate: true })}
          />
        </div>
        <FormField
          control={form.control}
          name="schedule.shift.endMin"
          label="Shift ends"
          render={(f, a) => <TimeInput {...a} value={f.value} onChange={f.onChange} />}
        />
      </div>
      <FormField
        control={form.control}
        name="description"
        label="Describe the work"
        required
        className="sm:col-span-2"
        render={(f, a) => (
          <Textarea
            {...a}
            {...f}
            rows={4}
            placeholder="Location details, duties, uniform, special requirements…"
          />
        )}
      />
      <FormField
        control={form.control}
        name="budgetPaise"
        label="Budget (optional)"
        render={(f, a) => (
          <MoneyInput
            {...a}
            value={f.value ?? null}
            onChange={(v) => f.onChange(v ?? undefined)}
            onBlur={f.onBlur}
          />
        )}
      />
      {apiError && !(apiError.status === 400 && apiError.details.length > 0) && (
        <Alert className="sm:col-span-2">{apiError.message}</Alert>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" loading={pending} className="w-full sm:w-auto">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
