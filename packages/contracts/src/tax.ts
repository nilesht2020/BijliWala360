import { applyBasisPoints, assertPaise } from './money';

/**
 * GST engine for quotations and (later) invoices (FR-QUO-06, BR-FIN-05). Pure integer arithmetic on
 * paise, shared by the API (authoritative) and the web (live totals while editing).
 *
 *  - line amount   = rate x headcount x quantity
 *  - the discount is spread over lines in proportion to their amounts (largest-remainder, so the
 *    allocated parts always add up exactly), and GST is charged on the discounted value
 *  - intra-state supply (supplier state = place of supply): CGST and SGST at half the rate each,
 *    each rounded half-up per line; inter-state: IGST at the full rate, rounded half-up per line
 */

export type SupplyType = 'INTRA' | 'INTER';

export interface TaxLineInput {
  ratePaise: number;
  headcount: number;
  quantity: number;
  gstRateBp: number;
}

export interface TaxLineResult {
  amountPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
}

export interface TaxTotals {
  type: SupplyType;
  lines: TaxLineResult[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalTaxPaise: number;
  totalPaise: number;
}

/** Largest amount a single line may reach (₹1,000 crore): keeps every product a safe integer. */
export const MAX_LINE_PAISE = 1e12;

export class TaxInputError extends RangeError {
  constructor(
    message: string,
    readonly field: 'lines' | 'discountPaise',
  ) {
    super(message);
  }
}

export function supplyTypeOf(supplierStateCode: string, placeOfSupplyStateCode: string): SupplyType {
  return supplierStateCode === placeOfSupplyStateCode ? 'INTRA' : 'INTER';
}

/** Half of a basis-point rate, applied with half-up rounding (e.g. 9% CGST of an 18% slab). */
function halfRate(taxablePaise: number, gstRateBp: number): number {
  return Math.floor((taxablePaise * gstRateBp + 10_000) / 20_000);
}

/** Splits `total` across `weights` proportionally; parts are integers that sum exactly to `total`. */
export function allocateProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const parts = exact.map(Math.floor);
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    parts[i] = (parts[i] ?? 0) + 1;
    remainder -= 1;
  }
  return parts;
}

export function computeTaxTotals(input: {
  lines: TaxLineInput[];
  discountPaise: number;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
}): TaxTotals {
  const type = supplyTypeOf(input.supplierStateCode, input.placeOfSupplyStateCode);
  assertPaise(input.discountPaise);
  const amounts = input.lines.map((l) => {
    assertPaise(l.ratePaise);
    if (!Number.isInteger(l.headcount) || l.headcount < 1 || !Number.isInteger(l.quantity) || l.quantity < 1)
      throw new TaxInputError('Headcount and quantity must be positive whole numbers.', 'lines');
    const amount = l.ratePaise * l.headcount * l.quantity;
    if (!Number.isSafeInteger(amount) || amount > MAX_LINE_PAISE)
      throw new TaxInputError('A line amount is too large.', 'lines');
    return amount;
  });
  const subtotalPaise = amounts.reduce((a, b) => a + b, 0);
  if (input.discountPaise > subtotalPaise)
    throw new TaxInputError('The discount cannot exceed the subtotal.', 'discountPaise');
  const discounts = allocateProportionally(input.discountPaise, amounts);

  const lines = input.lines.map((l, i): TaxLineResult => {
    const amountPaise = amounts[i] ?? 0;
    const discountPaise = discounts[i] ?? 0;
    const taxablePaise = amountPaise - discountPaise;
    const cgstPaise = type === 'INTRA' ? halfRate(taxablePaise, l.gstRateBp) : 0;
    const sgstPaise = cgstPaise;
    const igstPaise = type === 'INTER' ? applyBasisPoints(taxablePaise, l.gstRateBp) : 0;
    return {
      amountPaise,
      discountPaise,
      taxablePaise,
      cgstPaise,
      sgstPaise,
      igstPaise,
      taxPaise: cgstPaise + sgstPaise + igstPaise,
    };
  });

  const sum = (k: keyof TaxLineResult) => lines.reduce((a, l) => a + l[k], 0);
  const taxablePaise = sum('taxablePaise');
  const totalTaxPaise = sum('taxPaise');
  return {
    type,
    lines,
    subtotalPaise,
    discountPaise: input.discountPaise,
    taxablePaise,
    cgstPaise: sum('cgstPaise'),
    sgstPaise: sum('sgstPaise'),
    igstPaise: sum('igstPaise'),
    totalTaxPaise,
    totalPaise: taxablePaise + totalTaxPaise,
  };
}
