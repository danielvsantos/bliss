import { describe, it, expect } from 'vitest';

import { normalizeMerchant, hashMerchant } from '../../../utils/merchantNormalize.js';

/**
 * merchantNormalize.js is the ESM mirror of normalizeMerchant() in
 * apps/backend/src/services/recurringDetectionService.js. It MUST produce
 * identical keys so the API's "confirm from a transaction" path hashes to the
 * same descriptionHash the detection worker computes.
 *
 * These cases mirror the backend unit test — if the two implementations drift,
 * one of the two suites fails.
 */
describe('merchantNormalize', () => {
  it('strips TLDs, card masks, dates, ref numbers and punctuation', () => {
    expect(normalizeMerchant('NETFLIX.COM  xxxx1234  04/12  #00421')).toBe('netflix');
  });

  it('collapses real-world descriptor variants of one merchant to a single key', () => {
    const variants = [
      'Netflix',
      'NETFLIX.COM',
      'NETFLIX.COM #04821',
      'SQ *NETFLIX',
      'PAYPAL *NETFLIX',
      'TST* NETFLIX',
      'NETFLIX 08/15 POS DEBIT',
      'Netflix Inc',
      'Netflix 4',
      'NÉTFLIX',
    ];
    expect(new Set(variants.map(normalizeMerchant))).toEqual(new Set(['netflix']));
  });

  it('keeps genuinely different merchants distinct', () => {
    expect(normalizeMerchant('Netflix')).not.toBe(normalizeMerchant('Netflix Games'));
    expect(normalizeMerchant('ADOBE *CREATIVE CLD')).toBe('adobe creative cld');
  });

  it('never returns an empty key for a URL-only descriptor', () => {
    expect(normalizeMerchant('www.audible.com/manage')).toBe('audible manage');
  });

  it('strips trailing 1-2 digit sequence tokens', () => {
    expect(normalizeMerchant('Sodexo 4')).toBe('sodexo');
    expect(normalizeMerchant('Sodexo 07')).toBe('sodexo');
  });

  it('hashMerchant is a stable 64-char hex digest keyed on the normalized form', () => {
    const a = hashMerchant('SQ *NETFLIX');
    const b = hashMerchant('netflix.com');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
  });
});
