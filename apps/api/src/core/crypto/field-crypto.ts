import { Global, Injectable, Module } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { AppConfig } from '../config/app-config';

/** Stored shape of an encrypted field (DATABASE §1). */
export interface EncryptedValue {
  ct: string; // base64 ciphertext
  iv: string; // base64 12-byte IV
  tag: string; // base64 auth tag
  kv: number; // key version
}

export function parseKeyRing(spec: string): Map<number, Buffer> {
  const ring = new Map<number, Buffer>();
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [versionRaw, b64] = part.split(':');
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 1 || !b64) {
      throw new Error('FIELD_ENCRYPTION_KEYS must look like "1:<base64-32-bytes>,2:<base64-32-bytes>"');
    }
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`Encryption key v${version} must be 32 bytes`);
    ring.set(version, key);
  }
  if (ring.size === 0) throw new Error('FIELD_ENCRYPTION_KEYS is empty');
  return ring;
}

/**
 * AES-256-GCM field encryption with versioned keys (rotation: add a higher version, re-encrypt
 * lazily on write) plus HMAC-SHA256 hashes for equality lookups of sensitive values.
 */
export class FieldCryptoCore {
  private readonly currentVersion: number;

  constructor(
    private readonly keys: Map<number, Buffer>,
    private readonly pepper: string,
  ) {
    this.currentVersion = Math.max(...keys.keys());
  }

  encrypt(plaintext: string): EncryptedValue {
    const key = this.keys.get(this.currentVersion) as Buffer;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ct: ct.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      kv: this.currentVersion,
    };
  }

  decrypt(value: EncryptedValue): string {
    const key = this.keys.get(value.kv);
    if (!key) throw new Error(`Unknown encryption key version ${value.kv}`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.ct, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }

  needsReEncryption(value: EncryptedValue): boolean {
    return value.kv !== this.currentVersion;
  }

  /** Normalised, peppered hash used for uniqueness/lookup (e.g. ID numbers, mobiles). */
  hash(value: string, purpose: string): string {
    const normalised = value.replace(/\s+/g, '').toUpperCase();
    return createHmac('sha256', this.pepper).update(`${purpose}:${normalised}`).digest('hex');
  }

  static last4(value: string): string {
    return value.replace(/\s+/g, '').slice(-4);
  }
}

@Injectable()
export class FieldCrypto extends FieldCryptoCore {
  constructor(config: AppConfig) {
    super(parseKeyRing(config.env.FIELD_ENCRYPTION_KEYS), config.env.HASH_PEPPER);
  }
}

@Global()
@Module({ providers: [FieldCrypto], exports: [FieldCrypto] })
export class CryptoModule {}
