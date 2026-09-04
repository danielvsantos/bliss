/**
 * Single source of truth for "what the encryption key rotation touches."
 *
 * Consumed by:
 *   - rotate-encryption-key.mjs (re-encrypts every field listed here)
 *   - verify-encryption-key.mjs (proves every field listed here decrypts
 *     under the new key alone before ENCRYPTION_SECRET_PREVIOUS is removed)
 *   - encryptionRotationCoverage.test.ts (fails if a field in the Prisma
 *     middleware's `encryptedFields` registry has no entry here)
 *
 * PlaidTransaction.rawJson is intentionally listed even though it is NOT in
 * the automatic `encryptedFields` registry — it's encrypted by hand in
 * plaidSyncWorker.js. Without an explicit entry here it would silently
 * escape rotation (see docs/guides/key-rotation.md §2).
 */

const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isEmail = (value) => nonEmptyString(value) && value.includes('@');
const isJsonParseable = (value) => {
  if (!nonEmptyString(value)) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

export const ROTATION_COVERAGE = [
  {
    label: 'User.email',
    model: 'User',
    prismaModel: 'user',
    idField: 'id',
    orderBy: { id: 'asc' },
    fields: [{ name: 'email', searchable: true, sanity: isEmail }],
  },
  {
    label: 'Account.accountNumber',
    model: 'Account',
    prismaModel: 'account',
    idField: 'id',
    orderBy: { id: 'asc' },
    fields: [{ name: 'accountNumber', searchable: false, sanity: nonEmptyString }],
  },
  {
    label: 'Transaction.description/details',
    model: 'Transaction',
    prismaModel: 'transaction',
    idField: 'id',
    orderBy: { id: 'asc' },
    fields: [
      { name: 'description', searchable: false, sanity: nonEmptyString },
      { name: 'details', searchable: false, sanity: nonEmptyString },
    ],
  },
  {
    label: 'PlaidItem.accessToken',
    model: 'PlaidItem',
    prismaModel: 'plaidItem',
    idField: 'id',
    orderBy: { id: 'asc' },
    fields: [{ name: 'accessToken', searchable: false, sanity: nonEmptyString }],
  },
  {
    label: 'RecurringCharge.merchantLabel',
    model: 'RecurringCharge',
    prismaModel: 'recurringCharge',
    idField: 'id',
    orderBy: { id: 'asc' },
    fields: [{ name: 'merchantLabel', searchable: false, sanity: nonEmptyString }],
  },
  {
    label: 'PlaidTransaction.rawJson',
    model: 'PlaidTransaction',
    prismaModel: 'plaidTransaction',
    idField: 'id',
    orderBy: { id: 'asc' },
    manual: true, // encrypted by hand in plaidSyncWorker.js, not via encryptedFields
    fields: [{ name: 'rawJson', searchable: false, sanity: isJsonParseable }],
  },
];

/**
 * Cross-checks the manifest against the Prisma-middleware `encryptedFields`
 * registry. Throws when a registry field has no matching manifest entry, or
 * when the `searchable` flag disagrees — so a newly-registered encrypted
 * field can't silently escape rotation/verification coverage.
 */
export function assertCoverageComplete(encryptedFields) {
  const byModelField = new Map();
  for (const entry of ROTATION_COVERAGE) {
    for (const field of entry.fields) {
      byModelField.set(`${entry.model}.${field.name}`, field);
    }
  }

  const problems = [];
  for (const [modelName, fields] of Object.entries(encryptedFields)) {
    for (const [fieldName, config] of Object.entries(fields)) {
      const key = `${modelName}.${fieldName}`;
      const covered = byModelField.get(key);
      if (!covered) {
        problems.push(`${key} is missing from ROTATION_COVERAGE`);
        continue;
      }
      if (Boolean(covered.searchable) !== Boolean(config.searchable)) {
        problems.push(
          `${key} searchable flag mismatch: encryptedFields=${Boolean(config.searchable)}, ROTATION_COVERAGE=${Boolean(covered.searchable)}`
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      'Encryption rotation coverage is incomplete. Add the missing field(s) to ' +
        `apps/api/scripts/lib/encryptionRotationCoverage.mjs before rotating: ${problems.join('; ')}`
    );
  }
}
