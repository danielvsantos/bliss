const { timingSafeCompare } = require('../../../utils/timingSafeCompare');

describe('timingSafeCompare', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeCompare('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(timingSafeCompare('abc123', 'abc124')).toBe(false);
  });

  // The whole point of the length guard: crypto.timingSafeEqual throws on
  // unequal buffer lengths. An unguarded call turns a wrong-length credential
  // into a 500 instead of a 401.
  it('returns false — never throws — for different lengths', () => {
    expect(() => timingSafeCompare('short', 'a-much-longer-value')).not.toThrow();
    expect(timingSafeCompare('short', 'a-much-longer-value')).toBe(false);
    expect(timingSafeCompare('a-much-longer-value', 'short')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeCompare('', '')).toBe(true);
  });

  it('returns false when either side is not a string', () => {
    expect(timingSafeCompare(undefined, 'abc')).toBe(false);
    expect(timingSafeCompare('abc', undefined)).toBe(false);
    expect(timingSafeCompare(null, null)).toBe(false);
    expect(timingSafeCompare(['abc'], 'abc')).toBe(false);
    expect(timingSafeCompare(123, 123)).toBe(false);
  });

  it('compares by bytes, so multi-byte characters are handled correctly', () => {
    // 'é' is 2 bytes in UTF-8, 'e' is 1 — same JS .length, different byte length.
    expect(() => timingSafeCompare('é', 'e')).not.toThrow();
    expect(timingSafeCompare('é', 'e')).toBe(false);
    expect(timingSafeCompare('é', 'é')).toBe(true);
  });
});
