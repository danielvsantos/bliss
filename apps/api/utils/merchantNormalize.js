import crypto from 'crypto';

/**
 * ESM mirror of `normalizeMerchant()` in
 * apps/backend/src/services/recurringDetectionService.js.
 *
 * Used by the Subscriptions API's "confirm from a transaction" path so the
 * provisional RecurringCharge row it writes lands on the SAME
 * `descriptionHash` the detection worker would compute for that merchant.
 *
 * ⚠ Keep byte-identical to the backend version.
 *
 * @param {string} description Raw transaction description.
 * @returns {string} Normalized merchant key.
 */
export function normalizeMerchant(description) {
  const cleaned = String(description || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')     // strip accents
    .replace(/^\s*(?:sq|sqc|tst|pp|pyp|ppl|dd|cke|clv|sp|py|paypal|pos)\s*\*+\s*/, ' ') // payment-aggregator prefix: "SQ *", "PAYPAL *", "TST*" (allow-list \u2014 never a merchant's own name)
    .replace(/\bwww\./g, ' ')                              // URL prefix: "www.audible.com" -> "audible.com"
    .replace(/\.(?:com|net|org|io|co|app|dev|ai|tv|fm|gg|me|shop|store|xyz|cloud|info|biz)\b/g, ' ') // TLDs
    .replace(/\bx{2,}\d+\b/g, ' ')                         // masked card numbers: xxxx1234
    .replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ') // dates: 04/12, 2026-01-03
    .replace(/#?\s?\d{3,}/g, ' ')                          // store / ref numbers
    .replace(/[^a-z0-9&]+/g, ' ')                          // collapse punctuation to space
    .replace(/\b(purchase|payment|pos|debit|card|recurring|autopay|ppd|id|ref|trace|www|http|https)\b/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|gmbh|plc|lp|llp)\b\s*$/, ' ') // trailing corporate suffix
    .replace(/\s+/g, ' ')
    .trim();

  // Drop a trailing run of 1-2 digit tokens (bank-statement sequence artifacts:
  // "NETFLIX 4", "SODEXO 07"). Keep the original if stripping would empty the key.
  const deSuffixed = cleaned.replace(/(?:\s+\d{1,2})+$/, '').trim();
  return deSuffixed || cleaned;
}

/** SHA-256 hex of the normalized merchant key. */
export function hashMerchant(description) {
  return crypto.createHash('sha256').update(normalizeMerchant(description)).digest('hex');
}
