import { randomBytes } from 'node:crypto';
import { redact } from './audit/audit.service';
import { validateEnv } from './config/env.schema';
import { FieldCryptoCore, parseKeyRing } from './crypto/field-crypto';
import { financialYearOf } from './database/sequence.service';
import { isTransientTxnError, isUnknownCommitResult } from './database/transaction-runner';
import { hashRequest, stableStringify } from './idempotency/idempotency.interceptor';
import { parseClamdReply } from './scanning/clamav.client';

const key = () => randomBytes(32).toString('base64');

describe('FieldCrypto', () => {
  const pepper = 'p'.repeat(32);

  it('round-trips and uses random IVs', () => {
    const crypto = new FieldCryptoCore(parseKeyRing(`1:${key()}`), pepper);
    const a = crypto.encrypt('ABCDE1234F');
    const b = crypto.encrypt('ABCDE1234F');
    expect(a.ct).not.toBe(b.ct);
    expect(crypto.decrypt(a)).toBe('ABCDE1234F');
  });

  it('encrypts with the highest key version and still decrypts older versions', () => {
    const k1 = key();
    const old = new FieldCryptoCore(parseKeyRing(`1:${k1}`), pepper).encrypt('secret');
    const rotated = new FieldCryptoCore(parseKeyRing(`1:${k1},2:${key()}`), pepper);
    expect(rotated.decrypt(old)).toBe('secret');
    expect(rotated.needsReEncryption(old)).toBe(true);
    expect(rotated.encrypt('x').kv).toBe(2);
  });

  it('detects tampering via the GCM auth tag', () => {
    const crypto = new FieldCryptoCore(parseKeyRing(`1:${key()}`), pepper);
    const enc = crypto.encrypt('secret');
    const tampered = { ...enc, ct: Buffer.from('other').toString('base64') };
    expect(() => crypto.decrypt(tampered)).toThrow();
  });

  it('hashes are normalised, purpose-scoped and deterministic', () => {
    const crypto = new FieldCryptoCore(parseKeyRing(`1:${key()}`), pepper);
    expect(crypto.hash('abcde 1234f', 'PAN')).toBe(crypto.hash('ABCDE1234F', 'PAN'));
    expect(crypto.hash('ABCDE1234F', 'PAN')).not.toBe(crypto.hash('ABCDE1234F', 'MOBILE'));
    expect(FieldCryptoCore.last4('1234 5678 9012')).toBe('9012');
  });

  it('rejects malformed key rings', () => {
    expect(() => parseKeyRing('nope')).toThrow();
    expect(() => parseKeyRing(`1:${randomBytes(16).toString('base64')}`)).toThrow(/32 bytes/);
  });
});

describe('transaction error classification', () => {
  it('treats TransientTransactionError labels and WriteConflict as retryable', () => {
    expect(isTransientTxnError({ errorLabels: ['TransientTransactionError'] })).toBe(true);
    expect(isTransientTxnError({ hasErrorLabel: (l: string) => l === 'TransientTransactionError' })).toBe(
      true,
    );
    expect(isTransientTxnError({ code: 112 })).toBe(true);
    expect(isTransientTxnError(new Error('boom'))).toBe(false);
    expect(isUnknownCommitResult({ errorLabels: ['UnknownTransactionCommitResult'] })).toBe(true);
  });
});

describe('idempotency hashing', () => {
  it('is insensitive to key order and undefined values', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [1, { y: 1, x: 2 }] }, z: undefined })).toBe(
      stableStringify({ a: { c: [1, { x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
    expect(hashRequest({ a: 1 }, { id: 'x' })).not.toBe(hashRequest({ a: 2 }, { id: 'x' }));
  });
});

describe('financialYearOf (IST)', () => {
  it.each([
    ['2026-11-13T10:00:00Z', '2026-27'],
    ['2027-03-31T18:00:00Z', '2026-27'], // 23:30 IST on 31 Mar
    ['2027-03-31T18:31:00Z', '2027-28'], // 00:01 IST on 1 Apr
    ['2099-04-01T00:00:00Z', '2099-00'],
  ])('%s -> %s', (iso, fy) => {
    expect(financialYearOf(new Date(iso))).toBe(fy);
  });
});

describe('parseClamdReply', () => {
  it('parses clean and infected replies', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ clean: true });
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      clean: false,
      signature: 'Win.Test.EICAR_HDB-1',
    });
    expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR')).toThrow();
  });
});

describe('audit redaction', () => {
  it('redacts sensitive keys at any depth and stringifies ObjectId-like values', () => {
    const out = redact({
      name: 'A',
      passwordHash: 'x',
      bank: { accountEnc: { ct: '1' }, ifsc: 'HDFC0001' },
      ref: { toHexString: () => 'abc' },
    }) as Record<string, unknown>;
    expect(out).toEqual({
      name: 'A',
      passwordHash: '[REDACTED]',
      bank: { accountEnc: '[REDACTED]', ifsc: 'HDFC0001' },
      ref: 'abc',
    });
  });
});

describe('validateEnv', () => {
  const base = {
    MONGO_URI: 'mongodb://localhost/x',
    JWT_ACCESS_SECRET: 'j'.repeat(32),
    FIELD_ENCRYPTION_KEYS: `1:${key()}`,
    HASH_PEPPER: 'h'.repeat(32),
  };

  it('applies defaults and parses lists/booleans', () => {
    const env = validateEnv({ ...base, CORS_ORIGINS: 'http://a.test, http://b.test', LOG_PRETTY: 'true' });
    expect(env.PORT).toBe(3000);
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(env.LOG_PRETTY).toBe(true);
  });

  it('accepts a 6-digit development OTP but refuses it in production', () => {
    expect(validateEnv({ ...base, DEV_FIXED_OTP: '123456' }).DEV_FIXED_OTP).toBe('123456');
    expect(() => validateEnv({ ...base, DEV_FIXED_OTP: '12ab' })).toThrow(/DEV_FIXED_OTP/);
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        QUEUE_MODE: 'queue',
        STORAGE_DRIVER: 's3',
        SCANNER: 'clamav',
        RAZORPAY_KEY_ID: 'k',
        RAZORPAY_KEY_SECRET: 's',
        RAZORPAY_WEBHOOK_SECRET: 'w',
        DEV_FIXED_OTP: '123456',
      }),
    ).toThrow(/DEV_FIXED_OTP must not be set in production/);
  });

  it('fails fast listing every problem', () => {
    expect(() => validateEnv({ JWT_ACCESS_SECRET: 'short' })).toThrow(/MONGO_URI[\s\S]*JWT_ACCESS_SECRET/);
  });
});
