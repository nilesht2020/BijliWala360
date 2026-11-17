import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) with RFC 4648 base32 secrets: compatible with
 * Google Authenticator, Microsoft Authenticator, 1Password, etc. Implemented in-house (~60 lines)
 * to avoid an extra dependency for a security-critical primitive.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160-bit secret, as recommended by RFC 4226
}

export function timeStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP value for a counter (RFC 4226 dynamic truncation). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const code =
    (((mac[offset] as number) & 0x7f) << 24) |
    (((mac[offset + 1] as number) & 0xff) << 16) |
    (((mac[offset + 2] as number) & 0xff) << 8) |
    ((mac[offset + 3] as number) & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(secretBase32: string, nowMs: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), timeStep(nowMs));
}

/**
 * Verifies a code within ±`window` steps of clock drift. Returns the matched time step (used for
 * replay protection) or null.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number = Date.now(),
  window = 1,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = timeStep(nowMs);
  const given = Buffer.from(code);
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), given)) return step;
  }
  return null;
}

export function otpauthUrl(secretBase32: string, account: string, issuer = 'SkillConnect'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Uniformly random numeric one-time password for SMS (FR-AUTH-04). */
export function generateNumericOtp(digits = 6): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}
