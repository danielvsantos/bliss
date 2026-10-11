/**
 * The label a bank-feed row (PlaidTransaction) is hashed and promoted under,
 * by provider (#132, decision D3).
 *
 * - Plaid: the cleaned merchant name, else the raw name (unchanged behaviour).
 * - Enable Banking: the joined remittance text (`name`). `merchantName` holds
 *   the counterparty name, which matched existing history worse in the spike,
 *   so it must not drive the duplicate hash or the stored description.
 *
 * Classification input is not affected: callers keep passing
 * `merchantName || name` to the classifier.
 */

export const BANK_PROVIDERS = Object.freeze({
  PLAID: 'PLAID',
  ENABLE_BANKING: 'ENABLE_BANKING',
});

/**
 * @param {{ name?: string | null, merchantName?: string | null }} tx
 * @param {string | null | undefined} provider
 * @returns {string}
 */
export function bankTxLabel(tx, provider) {
  if (provider === BANK_PROVIDERS.ENABLE_BANKING) {
    return tx?.name || tx?.merchantName || '';
  }
  return tx?.merchantName || tx?.name || '';
}
