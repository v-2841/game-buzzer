import { describe, expect, it } from 'vitest';
import {
  createRateLimiter,
  isFiniteNum,
  isFn,
  isObj,
  isStr,
} from './validation.ts';

describe('payload guards', () => {
  it('isStr', () => {
    expect(isStr('a')).toBe(true);
    expect(isStr(1)).toBe(false);
    expect(isStr(undefined)).toBe(false);
  });
  it('isFiniteNum rejects NaN/Infinity/non-numbers', () => {
    expect(isFiniteNum(0)).toBe(true);
    expect(isFiniteNum(-3)).toBe(true);
    expect(isFiniteNum(Number.NaN)).toBe(false);
    expect(isFiniteNum(Infinity)).toBe(false);
    expect(isFiniteNum('1')).toBe(false);
  });
  it('isFn', () => {
    expect(isFn(() => {})).toBe(true);
    expect(isFn(1)).toBe(false);
  });
  it('isObj', () => {
    expect(isObj({})).toBe(true);
    expect(isObj(null)).toBe(false);
    expect(isObj(1)).toBe(false);
  });
});

describe('rate limiter (token bucket)', () => {
  it('allows up to capacity then blocks, with independent buckets', () => {
    const allow = createRateLimiter();
    let ok = 0;
    for (let i = 0; i < 10; i++) if (allow('buzz', 5, 0)) ok++;
    expect(ok).toBe(5); // capacity 5, no refill
    expect(allow('buzz', 5, 0)).toBe(false);
    expect(allow('other', 5, 0)).toBe(true); // separate key
  });
});
