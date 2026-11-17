import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes, letting later utilities override earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** RFC 4122 v4 id for Idempotency-Key headers (ARCHITECTURE §8.2). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
