import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

import { isAdminAuthorized } from '../../../utils/adminAuth.js';
import { timingSafeCompare } from '../../../utils/timingSafeCompare.js';

const ADMIN_KEY = 'a-real-admin-api-key-32-chars-ok!';

function makeReq(headers: Record<string, unknown> = {}) {
  return { headers } as { headers: Record<string, unknown> };
}

describe('timingSafeCompare', () => {
  it('returns true only for an exact match', () => {
    expect(timingSafeCompare('abc123', 'abc123')).toBe(true);
    expect(timingSafeCompare('abc123', 'abc124')).toBe(false);
  });

  // The whole reason for the length guard: crypto.timingSafeEqual throws on
  // unequal buffer lengths, which would turn a wrong-length credential into a
  // 500 instead of a 401.
  it('returns false — never throws — on a length mismatch', () => {
    expect(() => timingSafeCompare('short', 'a-much-longer-value')).not.toThrow();
    expect(timingSafeCompare('short', 'a-much-longer-value')).toBe(false);
  });

  it('returns false for non-string input', () => {
    expect(timingSafeCompare(undefined, 'abc')).toBe(false);
    expect(timingSafeCompare(['abc'], 'abc')).toBe(false);
    expect(timingSafeCompare(null, null)).toBe(false);
  });

  it('compares by bytes, so multi-byte characters are handled', () => {
    expect(() => timingSafeCompare('é', 'e')).not.toThrow();
    expect(timingSafeCompare('é', 'e')).toBe(false);
    expect(timingSafeCompare('é', 'é')).toBe(true);
  });
});

describe('isAdminAuthorized', () => {
  const saved = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = saved;
  });

  it('accepts the correct key', () => {
    expect(isAdminAuthorized(makeReq({ 'x-admin-key': ADMIN_KEY }))).toBe(true);
  });

  it.each([
    ['a wrong key of the same length', 'a-WRONG-admin-api-key-32-chars!!!'],
    ['a wrong key of a different length', 'x'],
    ['an empty key', ''],
  ])('rejects %s', (_label, key) => {
    expect(isAdminAuthorized(makeReq({ 'x-admin-key': key }))).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(isAdminAuthorized(makeReq())).toBe(false);
  });

  it('rejects a non-string header value without throwing', () => {
    // Node collapses repeated headers into an array for some header names.
    expect(() => isAdminAuthorized(makeReq({ 'x-admin-key': [ADMIN_KEY] }))).not.toThrow();
    expect(isAdminAuthorized(makeReq({ 'x-admin-key': [ADMIN_KEY] }))).toBe(false);
  });

  // An unset key must never mean "no auth required". This is the single most
  // important property of this function.
  describe('fails closed when ADMIN_API_KEY is unset', () => {
    beforeEach(() => {
      delete process.env.ADMIN_API_KEY;
    });

    it.each([
      ['a matching-looking key', ADMIN_KEY],
      ['an empty key', ''],
      ['no header', undefined],
    ])('rejects %s', (_label, key) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const req = key === undefined ? makeReq() : makeReq({ 'x-admin-key': key });

      expect(isAdminAuthorized(req)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ADMIN_API_KEY env var is not set'));
    });
  });

  it('labels the warning with the calling route', () => {
    delete process.env.ADMIN_API_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    isAdminAuthorized(makeReq(), 'plaid/items/hard-delete');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[plaid/items/hard-delete]'));
  });
});
