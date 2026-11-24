import { PERMISSIONS } from '@bijliwala/contracts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../core/crypto/password';
import {
  base32Decode,
  base32Encode,
  generateNumericOtp,
  generateTotpSecret,
  hotp,
  otpauthUrl,
  timeStep,
  totp,
  verifyTotp,
} from './auth/domain/totp';
import { isWithinQuietHours, minuteOfDayIn, quietHoursDelayMs } from './notifications/domain/quiet-hours';
import { renderMessage } from './notifications/templates.service';
import { resolveAccess, roleAllowedForUserType, scopeKeyOf, SUPER_ADMIN } from './users/domain/access';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  // RFC 6238 Appendix B, SHA-1 secret "12345678901234567890"; we use the last 6 of the 8 digits.
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('t=%i -> %s', (seconds, expected) => {
    expect(totp(secret, seconds * 1000)).toBe(expected);
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    const key = Buffer.from('12345678901234567890');
    expect([0, 1, 2, 9].map((c) => hotp(key, c))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('accepts ±1 step of drift and returns the matched step', () => {
    const now = 1_700_000_000_000;
    const s = generateTotpSecret();
    expect(verifyTotp(s, totp(s, now - 30_000), now)).toBe(timeStep(now) - 1);
    expect(verifyTotp(s, totp(s, now + 30_000), now)).toBe(timeStep(now) + 1);
    expect(verifyTotp(s, totp(s, now + 90_000), now)).toBeNull();
    expect(verifyTotp(s, 'abcdef', now)).toBeNull();
  });

  it('round-trips base32 and builds an otpauth URL', () => {
    const raw = Buffer.from([0, 1, 2, 250, 255]);
    expect(base32Decode(base32Encode(raw))).toEqual(raw);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl('ABC', 'a@b.test')).toBe(
      'otpauth://totp/Bijli%20Wala%3Aa%40b.test?secret=ABC&issuer=Bijli+Wala&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('generates zero-padded numeric OTPs', () => {
    for (let i = 0; i < 200; i += 1) expect(generateNumericOtp()).toMatch(/^\d{6}$/);
  });
});

describe('password hashing (scrypt)', () => {
  const fast = { N: 2 ** 10, r: 8, p: 1 };

  it('verifies the right password only and salts every hash', async () => {
    const a = await hashPassword('correct horse 123', fast);
    const b = await hashPassword('correct horse 123', fast);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$/);
    await expect(verifyPassword('correct horse 123', a)).resolves.toBe(true);
    await expect(verifyPassword('correct horse 124', a)).resolves.toBe(false);
  });

  it('rejects malformed hashes without throwing', async () => {
    await expect(verifyPassword('x', 'bcrypt$whatever')).resolves.toBe(false);
  });

  it('creates high-entropy tokens and stable digests', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256('a')).toBe(sha256('a'));
  });
});

describe('access resolution', () => {
  const roles = [
    { code: 'OPS_ADMIN', permissions: ['job.read', 'job.manage', 'not.a.permission'] },
    { code: 'FINANCE_ADMIN', permissions: ['job.read', 'payment.verify'] },
    { code: SUPER_ADMIN, permissions: [] },
    { code: 'COMPANY_ADMIN', permissions: ['company.manage'] },
  ];

  it('unions permissions across roles and ignores unknown codes', () => {
    const access = resolveAccess(
      [
        { roleCode: 'OPS_ADMIN', scope: { type: 'PLATFORM' } },
        { roleCode: 'FINANCE_ADMIN', scope: { type: 'PLATFORM' } },
      ],
      roles,
    );
    expect([...access.permissions].sort()).toEqual(['job.manage', 'job.read', 'payment.verify']);
    expect(access.roleCodes).toEqual(['FINANCE_ADMIN', 'OPS_ADMIN']);
    expect(access.scopes).toEqual([{ type: 'PLATFORM' }]);
  });

  it('gives Super Admin every permission even if its stored list is stale', () => {
    const access = resolveAccess([{ roleCode: SUPER_ADMIN, scope: { type: 'PLATFORM' } }], roles);
    expect(access.permissions.size).toBe(PERMISSIONS.length);
  });

  it('keeps one scope per company and ignores assignments of deleted roles', () => {
    const access = resolveAccess(
      [
        { roleCode: 'COMPANY_ADMIN', scope: { type: 'COMPANY', companyId: 'c1' } },
        { roleCode: 'COMPANY_ADMIN', scope: { type: 'COMPANY', companyId: 'c1' } },
        { roleCode: 'COMPANY_ADMIN', scope: { type: 'COMPANY', companyId: 'c2' } },
        { roleCode: 'DELETED_ROLE', scope: { type: 'PLATFORM' } },
      ],
      roles,
    );
    expect(access.scopes).toEqual([
      { type: 'COMPANY', companyId: 'c1' },
      { type: 'COMPANY', companyId: 'c2' },
    ]);
    expect(access.roleCodes).toEqual(['COMPANY_ADMIN']);
  });

  it('builds scope keys', () => {
    expect(scopeKeyOf({ type: 'PLATFORM' })).toBe('PLATFORM');
    expect(scopeKeyOf({ type: 'VENDOR', vendorId: 'v' })).toBe('VENDOR:v');
  });

  it.each([
    [{ code: 'OPS_ADMIN', scopeType: 'PLATFORM' as const }, 'ADMIN', true],
    [{ code: 'OPS_ADMIN', scopeType: 'PLATFORM' as const }, 'PROFESSIONAL', false],
    [{ code: 'PROFESSIONAL', scopeType: 'PLATFORM' as const }, 'PROFESSIONAL', true],
    [{ code: 'PROFESSIONAL', scopeType: 'PLATFORM' as const }, 'ADMIN', false],
    [{ code: 'COMPANY_USER', scopeType: 'COMPANY' as const }, 'COMPANY', true],
    [{ code: 'COMPANY_USER', scopeType: 'COMPANY' as const }, 'VENDOR', false],
    [{ code: 'VENDOR_ADMIN', scopeType: 'VENDOR' as const }, 'VENDOR', true],
    [{ code: 'VENDOR_WORKER', scopeType: 'VENDOR' as const }, 'VENDOR_WORKER', true],
    [{ code: 'VENDOR_WORKER', scopeType: 'VENDOR' as const }, 'VENDOR', false],
  ] as const)('%j allowed for %s = %s', (role, userType, expected) => {
    expect(roleAllowedForUserType(role, userType)).toBe(expected);
  });
});

describe('quiet hours', () => {
  const q = { enabled: true, startMin: 21 * 60, endMin: 8 * 60 };

  it('handles windows that wrap past midnight', () => {
    expect(isWithinQuietHours(22 * 60, q)).toBe(true);
    expect(isWithinQuietHours(7 * 60 + 59, q)).toBe(true);
    expect(isWithinQuietHours(8 * 60, q)).toBe(false);
    expect(isWithinQuietHours(12 * 60, q)).toBe(false);
    expect(isWithinQuietHours(22 * 60, { ...q, enabled: false })).toBe(false);
  });

  it('computes the delay until quiet hours end in IST', () => {
    const at2330Ist = new Date('2026-11-13T18:00:00Z'); // 23:30 IST
    expect(minuteOfDayIn(at2330Ist, 'Asia/Kolkata')).toBe(23 * 60 + 30);
    expect(quietHoursDelayMs(at2330Ist, q)).toBe((8 * 60 + 30) * 60_000);
    expect(quietHoursDelayMs(new Date('2026-11-13T06:30:00Z'), q)).toBe(0); // 12:00 IST
  });
});

describe('template rendering', () => {
  it('renders each channel and escapes data in email HTML', () => {
    expect(
      renderMessage(
        { channel: 'SMS', sms: { body: 'Hi {{name}}, job {{job.no}}' } },
        { name: 'Asha', job: { no: 'J-1' } },
      ).body,
    ).toBe('Hi Asha, job J-1');
    const email = renderMessage(
      { channel: 'EMAIL', email: { subject: 'Hello {{name}}', html: '<p>{{name}}</p>' } },
      { name: '<script>x</script>' },
    );
    expect(email.html).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
    const wa = renderMessage(
      {
        channel: 'WHATSAPP',
        whatsapp: { templateName: 'invite_v1', language: 'en', paramOrder: ['name', 'missing'] },
      },
      { name: 'Ravi' },
    );
    expect(wa.whatsapp).toEqual({ templateName: 'invite_v1', language: 'en', params: ['Ravi', ''] });
  });
});
