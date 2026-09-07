import { describe, it, expect } from 'vitest';
import { decrypt } from '../../../utils/encryption.js';
import { buildFakePlaidPayload, buildFixturePlaidTransaction } from '../../../scripts/seed-plaid-fixtures.mjs';

describe('seed-plaid-fixtures', () => {
  it('builds a fake Plaid payload with the fields plaidSyncWorker.js expects', () => {
    const payload = buildFakePlaidPayload(0);
    expect(payload.transaction_id).toBe('fixture-txn-0');
    expect(payload.account_id).toBeTruthy();
    expect(typeof payload.amount).toBe('number');
  });

  it('rawJson decrypts under the active key and round-trips through JSON.parse (the rawJson gap this task fixes)', () => {
    const record = buildFixturePlaidTransaction('fixture-item-1', 3);
    const decrypted = decrypt(record.rawJson!);
    const parsed = JSON.parse(decrypted);
    expect(parsed.transaction_id).toBe('fixture-txn-3');
  });

  it('produces unique plaidTransactionId per index so createMany does not collide', () => {
    const a = buildFixturePlaidTransaction('item', 1);
    const b = buildFixturePlaidTransaction('item', 2);
    expect(a.plaidTransactionId).not.toBe(b.plaidTransactionId);
  });
});
