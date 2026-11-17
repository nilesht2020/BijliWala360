import {
  allocateProportionally,
  canTransitionEnquiry,
  canTransitionJob,
  companyCreateSchema,
  computeTaxTotals,
  enquiryScheduleSchema,
  ENQUIRY_STATUSES,
  JOB_STATUSES,
  JOB_TRANSITIONS,
  paymentTermsSchema,
  publicEnquirySchema,
  TaxInputError,
} from './index';

const intra = { supplierStateCode: '27', placeOfSupplyStateCode: '27' };
const inter = { supplierStateCode: '27', placeOfSupplyStateCode: '29' };

describe('GST engine', () => {
  it('splits intra-state tax into equal CGST and SGST and inter-state into IGST', () => {
    const lines = [{ ratePaise: 100_000, headcount: 2, quantity: 10, gstRateBp: 1800 }];
    const a = computeTaxTotals({ lines, discountPaise: 0, ...intra });
    expect(a).toMatchObject({
      type: 'INTRA',
      subtotalPaise: 2_000_000,
      cgstPaise: 180_000,
      sgstPaise: 180_000,
      igstPaise: 0,
    });
    expect(a.totalPaise).toBe(2_360_000);
    const b = computeTaxTotals({ lines, discountPaise: 0, ...inter });
    expect(b).toMatchObject({
      type: 'INTER',
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 360_000,
      totalPaise: 2_360_000,
    });
  });

  it('rounds half-up per line', () => {
    // 18% of 0.05 = 0.009 -> 0.01 ; 9% of 0.05 = 0.0045 -> 0.00 each (half-up at the paisa)
    const one = computeTaxTotals({
      lines: [{ ratePaise: 5, headcount: 1, quantity: 1, gstRateBp: 1800 }],
      discountPaise: 0,
      ...inter,
    });
    expect(one.igstPaise).toBe(1);
    const half = computeTaxTotals({
      lines: [{ ratePaise: 25, headcount: 1, quantity: 1, gstRateBp: 1800 }],
      discountPaise: 0,
      ...intra,
    });
    // 9% of 0.25 = 0.0225 -> 0.02
    expect(half.cgstPaise).toBe(2);
  });

  it('spreads the discount exactly across lines before tax', () => {
    const t = computeTaxTotals({
      lines: [
        { ratePaise: 333, headcount: 1, quantity: 1, gstRateBp: 1800 },
        { ratePaise: 333, headcount: 1, quantity: 1, gstRateBp: 500 },
        { ratePaise: 334, headcount: 1, quantity: 1, gstRateBp: 0 },
      ],
      discountPaise: 100,
      ...inter,
    });
    expect(t.lines.reduce((a, l) => a + l.discountPaise, 0)).toBe(100);
    expect(t.taxablePaise).toBe(900);
    expect(t.totalPaise).toBe(t.taxablePaise + t.totalTaxPaise);
  });

  it('refuses a discount above the subtotal and absurd amounts', () => {
    expect(() =>
      computeTaxTotals({
        lines: [{ ratePaise: 100, headcount: 1, quantity: 1, gstRateBp: 1800 }],
        discountPaise: 101,
        ...intra,
      }),
    ).toThrow(TaxInputError);
    expect(() =>
      computeTaxTotals({
        lines: [{ ratePaise: 1e12, headcount: 10, quantity: 10, gstRateBp: 1800 }],
        discountPaise: 0,
        ...intra,
      }),
    ).toThrow(TaxInputError);
  });

  it('allocates proportionally with exact sums', () => {
    expect(allocateProportionally(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocateProportionally(0, [5, 5])).toEqual([0, 0]);
    expect(allocateProportionally(7, [0, 0])).toEqual([0, 0]);
  });
});

describe('demand schemas', () => {
  const billing = { line1: 'x', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' };

  it('requires the GSTIN to match the billing state and PAN', () => {
    expect(
      companyCreateSchema.safeParse({
        legalName: 'Acme',
        pan: 'ABCDE1234F',
        gstin: '27ABCDE1234F1Z5',
        billingAddress: billing,
      }).success,
    ).toBe(true);
    expect(
      companyCreateSchema.safeParse({
        legalName: 'Acme',
        pan: 'ABCDE1234F',
        gstin: '29ABCDE1234F1Z5',
        billingAddress: billing,
      }).success,
    ).toBe(false);
    expect(
      companyCreateSchema.safeParse({
        legalName: 'Acme',
        pan: 'ABCDE1234F',
        gstin: '27ZZZZZ1234F1Z5',
        billingAddress: billing,
      }).success,
    ).toBe(false);
    expect(
      companyCreateSchema.safeParse({
        legalName: 'Acme',
        pan: 'ABCDE1234F',
        billingAddress: { ...billing, stateCode: '99' },
      }).success,
    ).toBe(false);
  });

  it('validates schedules and milestones', () => {
    const shift = { startMin: 540, endMin: 1080 };
    expect(
      enquiryScheduleSchema.safeParse({
        startDate: '2030-01-10',
        endDate: '2030-01-01',
        weekdays: [1],
        shift,
      }).success,
    ).toBe(false);
    expect(
      enquiryScheduleSchema.safeParse({ startDate: '2030-01-10', weekdays: [1, 1], shift }).success,
    ).toBe(false);
    expect(
      enquiryScheduleSchema.safeParse({
        startDate: '2030-01-10',
        weekdays: [5, 1],
        shift: { startMin: 60, endMin: 60 },
      }).success,
    ).toBe(false);
    const ok = enquiryScheduleSchema.parse({
      startDate: '2030-01-10',
      weekdays: [5, 1],
      shift: { startMin: 1320, endMin: 360 },
    });
    expect(ok.weekdays).toEqual([1, 5]);
    expect(
      paymentTermsSchema.safeParse({
        advancePct: 0,
        milestones: [{ label: 'Start', pct: 40, due: 'ON_START' }],
      }).success,
    ).toBe(false);
    expect(
      paymentTermsSchema.safeParse({ advancePct: 0, milestones: [{ label: 'Mid', pct: 100, due: 'DATE' }] })
        .success,
    ).toBe(false);
  });

  it('rejects filled honeypots on public enquiries', () => {
    const base = {
      categoryId: 'a'.repeat(24),
      lines: [{ skillId: 'b'.repeat(24), headcount: 1 }],
      schedule: { startDate: '2030-01-10', weekdays: [1], shift: { startMin: 540, endMin: 1080 } },
      description: 'Need two cleaners',
      lead: { name: 'Anil', companyName: 'Rao Co', mobile: '+919812345678', city: 'Pune' },
    };
    expect(publicEnquirySchema.safeParse(base).success).toBe(true);
    expect(publicEnquirySchema.safeParse({ ...base, website: 'http://spam' }).success).toBe(false);
  });
});

describe('state machines', () => {
  it('terminal statuses have no exits', () => {
    expect(JOB_TRANSITIONS.COMPLETED).toHaveLength(0);
    expect(JOB_TRANSITIONS.CANCELLED).toHaveLength(0);
    for (const s of ENQUIRY_STATUSES) expect(canTransitionEnquiry('ACCEPTED', s)).toBe(false);
  });

  it('every live job can be cancelled and put on hold (except from hold itself)', () => {
    for (const s of JOB_STATUSES.filter((x) => x !== 'COMPLETED' && x !== 'CANCELLED')) {
      expect(canTransitionJob(s, 'CANCELLED')).toBe(true);
      if (s !== 'ON_HOLD' && s !== 'DRAFT') expect(canTransitionJob(s, 'ON_HOLD')).toBe(true);
    }
    expect(canTransitionJob('DRAFT', 'STAFFED')).toBe(false);
    expect(canTransitionJob('OPEN', 'COMPLETED')).toBe(false);
  });

  it('a revision moves a quoted enquiry back into review', () => {
    expect(canTransitionEnquiry('QUOTED', 'IN_REVIEW')).toBe(true);
    expect(canTransitionEnquiry('REJECTED', 'QUOTED')).toBe(true);
    expect(canTransitionEnquiry('NEW', 'ACCEPTED')).toBe(false);
  });
});
