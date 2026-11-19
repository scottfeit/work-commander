import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare a secret someone sent with the real one in constant time, so response timing reveals nothing about how much of it
 * matched (hashing first makes the lengths equal too). Anything that isn't a non-empty string never matches.
 */
export function safeEqual(given: unknown, expected: unknown): boolean {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false;
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(given), h(expected));
}
