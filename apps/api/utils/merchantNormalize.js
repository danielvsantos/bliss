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
  return String(description || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')  // strip accents
    .replace(/\bx{2,}\d+\b/g, ' ')                          // masked card numbers: xxxx1234
    .replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ')  // dates: 04/12, 2026-01-03
    .replace(/#?\s?\d{3,}/g, ' ')                           // store / ref numbers
    .replace(/[^a-z0-9&]+/g, ' ')                           // collapse punctuation to space
    .replace(/\b(purchase|payment|pos|debit|card|recurring|autopay|ppd|id|ref|trace)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** SHA-256 hex of the normalized merchant key. */
export function hashMerchant(description) {
  return crypto.createHash('sha256').update(normalizeMerchant(description)).digest('hex');
}
