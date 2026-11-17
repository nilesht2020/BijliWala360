import {
  BUSINESS_CONFIG,
  BUSINESS_CONFIG_KEYS,
  ERROR_CODES,
  PERMISSIONS,
  SYSTEM_ROLES,
  applyBasisPoints,
  localDateSchema,
  parseBusinessConfigValue,
} from './index';

describe('business config registry', () => {
  it.each(BUSINESS_CONFIG_KEYS)('default for %s satisfies its own schema', (key) => {
    const entry = BUSINESS_CONFIG[key];
    expect(entry.schema.safeParse(entry.defaultValue).success).toBe(true);
  });

  it('rejects matching weights that do not sum to 1', () => {
    expect(() =>
      parseBusinessConfigValue('matching.weights', {
        skill: 0.5,
        distance: 0.5,
        experience: 0.5,
        rating: 0,
        reliability: 0,
        companyHistory: 0,
        workload: 0,
      }),
    ).toThrow();
  });
});

describe('system roles', () => {
  it('only reference known permissions and have unique codes', () => {
    const codes = new Set<string>();
    for (const role of SYSTEM_ROLES) {
      expect(codes.has(role.code)).toBe(false);
      codes.add(role.code);
      for (const p of role.permissions) expect(PERMISSIONS).toContain(p);
    }
  });

  it('keeps allocation approval separate from proposing for ops admins', () => {
    const ops = SYSTEM_ROLES.find((r) => r.code === 'OPS_ADMIN');
    expect(ops?.permissions).toContain('allocation.propose');
    expect(ops?.permissions).not.toContain('allocation.approve');
  });
});

describe('error codes', () => {
  it('map to valid HTTP statuses', () => {
    for (const status of Object.values(ERROR_CODES)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

describe('money', () => {
  it.each([
    [10000, 1800, 1800],
    [333, 1800, 60], // 59.94 -> 60
    [25, 1800, 5], // 4.5 -> 5 (half-up)
    [0, 1800, 0],
  ])('applyBasisPoints(%i, %i) = %i', (amount, bp, expected) => {
    expect(applyBasisPoints(amount, bp)).toBe(expected);
  });

  it('rejects non-integer paise', () => {
    expect(() => applyBasisPoints(10.5, 1800)).toThrow(RangeError);
  });
});

describe('localDateSchema', () => {
  it('accepts valid and rejects invalid dates', () => {
    expect(localDateSchema.safeParse('2026-11-13').success).toBe(true);
    expect(localDateSchema.safeParse('2026-13-01').success).toBe(false);
    expect(localDateSchema.safeParse('13-11-2026').success).toBe(false);
  });
});
