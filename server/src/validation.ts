// Runtime guards for untrusted socket payloads (TS types are compile-time only,
// the wire delivers whatever the client sends) and a per-connection rate limiter.

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

export const isStr = (v: unknown): v is string => typeof v === 'string';

export const isFiniteNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

export const isFn = (v: unknown): v is (...args: never[]) => void =>
  typeof v === 'function';

/**
 * Token-bucket rate limiter keyed by an arbitrary string (typically the event
 * name), scoped per connection. `capacity` is the burst size; `refillPerSec`
 * is the sustained rate. Returns false when the bucket is empty (drop event).
 */
export function createRateLimiter() {
  const buckets = new Map<string, { tokens: number; last: number }>();
  return (key: string, capacity: number, refillPerSec: number): boolean => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}
