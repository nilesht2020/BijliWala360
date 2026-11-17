import { Types } from 'mongoose';
import type { AuthUser } from '../core/auth/auth.types';
import { addDays, escapeRegex, todayIn } from '../core/database/query';
import { SimplePdf, wrapText } from '../core/pdf/simple-pdf';
import { companyScopeOf, siteFilterOf } from './companies/companies.module';
import { planJobEdit, resumeTargetOf, staffingStatusAfterEdit, type PositionDoc } from './jobs/domain';

function position(over: Partial<PositionDoc> = {}): PositionDoc {
  return {
    _id: new Types.ObjectId(),
    skillId: new Types.ObjectId(),
    title: 'Cleaner',
    minExperienceYears: 0,
    requiredCertDocTypeCodes: [],
    shift: { startMin: 540, endMin: 1080 },
    required: 5,
    held: 0,
    confirmed: 0,
    available: 5,
    billRatePaise: 80_000,
    billUnit: 'DAY',
    showPayRate: false,
    allowPartialAvailability: false,
    ...over,
  };
}

const asInput = (p: PositionDoc, over: Record<string, unknown> = {}) => ({
  id: p._id.toHexString(),
  skillId: p.skillId.toHexString(),
  title: p.title,
  minExperienceYears: p.minExperienceYears,
  requiredCertDocTypeCodes: p.requiredCertDocTypeCodes,
  shift: p.shift,
  required: p.required,
  billRatePaise: p.billRatePaise,
  billUnit: p.billUnit,
  showPayRate: false,
  allowPartialAvailability: false,
  ...over,
});

describe('job edit planning (FR-JOB-04/05)', () => {
  it('recomputes available and never drops below held + confirmed', () => {
    const p = position({ held: 2, confirmed: 1, available: 2 });
    const { positions } = planJobEdit([p], [asInput(p, { required: 8 })], false);
    expect(positions[0]).toMatchObject({ required: 8, held: 2, confirmed: 1, available: 5 });
    expect(() => planJobEdit([p], [asInput(p, { required: 2 })], false)).toThrow(/cannot go below/);
  });

  it('refuses removing or re-skilling a position with commitments, allows it otherwise', () => {
    const busy = position({ held: 1, available: 4 });
    const idle = position();
    expect(() => planJobEdit([busy, idle], [asInput(idle)], false)).toThrow(/cannot be removed/);
    expect(() =>
      planJobEdit([busy], [asInput(busy, { skillId: new Types.ObjectId().toHexString() })], false),
    ).toThrow(/skill cannot change/);
    expect(planJobEdit([busy, idle], [asInput(busy)], false).positions).toHaveLength(1);
  });

  it('reports schedule and shift impact only where allocations exist', () => {
    const busy = position({ confirmed: 2, available: 3 });
    const idle = position();
    const { impact } = planJobEdit(
      [busy, idle],
      [asInput(busy, { shift: { startMin: 600, endMin: 1140 } }), asInput(idle)],
      true,
    );
    expect(impact.map((i) => i.kind).sort()).toEqual(['SCHEDULE_CHANGED', 'SHIFT_CHANGED']);
    expect(impact.every((i) => i.positionId === busy._id.toHexString())).toBe(true);
  });

  it('adds new positions with zero counts and rejects unknown ids', () => {
    const p = position();
    const fresh = { ...asInput(p), id: undefined, required: 3 };
    const { positions } = planJobEdit([p], [asInput(p), fresh], false);
    expect(positions[1]).toMatchObject({ required: 3, held: 0, confirmed: 0, available: 3 });
    expect(() =>
      planJobEdit([p], [{ ...asInput(p), id: new Types.ObjectId().toHexString() }], false),
    ).toThrow(/does not belong/);
  });

  it('resumes to the status the job was held from and re-derives staffing', () => {
    expect(
      resumeTargetOf([
        { from: 'NEW', to: 'OPEN' },
        { from: 'ALLOCATING', to: 'ON_HOLD' },
      ]),
    ).toBe('ALLOCATING');
    expect(resumeTargetOf([])).toBe('OPEN');
    expect(staffingStatusAfterEdit('STAFFED', [position({ required: 3, confirmed: 2 })])).toBe(
      'PARTIALLY_STAFFED',
    );
    expect(staffingStatusAfterEdit('PARTIALLY_STAFFED', [position({ required: 2, confirmed: 2 })])).toBe(
      'STAFFED',
    );
    expect(staffingStatusAfterEdit('OPEN', [position()])).toBe('OPEN');
  });
});

describe('company scope', () => {
  const user = (scopes: AuthUser['scopes'], userType: AuthUser['userType'] = 'COMPANY'): AuthUser => ({
    id: 'u',
    userType,
    permVersion: 1,
    roleCodes: [],
    permissions: new Set(),
    scopes,
  });
  const c = new Types.ObjectId().toHexString();
  const s1 = new Types.ObjectId().toHexString();

  it('unrestricted when any grant has no site list', () => {
    expect(companyScopeOf(user([{ type: 'COMPANY', companyId: c }]))).toEqual({ companyId: c });
    expect(
      companyScopeOf(
        user([
          { type: 'COMPANY', companyId: c, siteIds: [s1] },
          { type: 'COMPANY', companyId: c },
        ]),
      ),
    ).toEqual({
      companyId: c,
    });
  });

  it('restricted to the granted sites, and none for non-company users', () => {
    const scope = companyScopeOf(user([{ type: 'COMPANY', companyId: c, siteIds: [s1] }]));
    expect(scope).toEqual({ companyId: c, siteIds: [s1] });
    expect(siteFilterOf(scope as { siteIds?: string[] })).toEqual({
      siteId: { $in: [new Types.ObjectId(s1)] },
    });
    expect(companyScopeOf(user([{ type: 'PLATFORM' }], 'ADMIN'))).toBeNull();
  });
});

describe('helpers', () => {
  it('escapes regex metacharacters', () => {
    expect(new RegExp(escapeRegex('a.b*(c)')).test('a.b*(c)')).toBe(true);
    expect(new RegExp(escapeRegex('a.b')).test('axb')).toBe(false);
  });

  it('computes IST dates', () => {
    expect(todayIn('Asia/Kolkata', new Date('2026-03-31T20:00:00Z'))).toBe('2026-04-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('PDF writer', () => {
  it('produces a structurally valid PDF with a correct xref table', () => {
    const pdf = new SimplePdf('footer (with parens) \\ and ₹');
    pdf.paragraph('Hello (world) ₹ 100');
    for (let i = 0; i < 80; i += 1) pdf.paragraph(`Line ${i}`); // forces a second page
    const buf = pdf.toBuffer();
    const text = buf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('Hello \\(world\\) ? 100');
    const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    // Every xref offset points at "<n> 0 obj".
    const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  it('wraps long text', () => {
    expect(wrapText('word '.repeat(60), 10, 200).length).toBeGreaterThan(3);
  });
});
