/**
 * Money helpers shared by API and web. All amounts are integer paise (BR-FIN-05).
 */

/** Percentage expressed in basis points (1800 = 18%). Rounds half-up to the nearest paisa. */
export function applyBasisPoints(amountPaise: number, basisPoints: number): number {
  assertPaise(amountPaise);
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError('basisPoints must be a non-negative integer');
  }
  // Integer arithmetic: (amount * bp + 5000) / 10000, floored => half-up for non-negative values.
  return Math.floor((amountPaise * basisPoints + 5000) / 10000);
}

export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees) || rupees < 0)
    throw new RangeError('rupees must be a non-negative finite number');
  return Math.round(rupees * 100);
}

export function assertPaise(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid paise amount: ${value}`);
  }
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPaise(amountPaise: number): string {
  return inrFormatter.format(amountPaise / 100);
}
