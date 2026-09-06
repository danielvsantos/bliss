import { describe, it, expect, vi } from 'vitest';
import {
  createKeyHelpers,
  migrateModel,
  run,
  keyFingerprint,
} from '../../../scripts/rotate-encryption-key.mjs';
import { ROTATION_COVERAGE } from '../../../scripts/lib/encryptionRotationCoverage.mjs';

const OLD_SECRET = 'old-secret-for-rotation-tests';
const NEW_SECRET = 'new-secret-for-rotation-tests';

describe('rotate-encryption-key: crypto helpers', () => {
  it('keyFingerprint is stable for a given secret and differs across secrets', () => {
    expect(keyFingerprint(OLD_SECRET)).toBe(keyFingerprint(OLD_SECRET));
    expect(keyFingerprint(OLD_SECRET)).not.toBe(keyFingerprint(NEW_SECRET));
    expect(keyFingerprint(OLD_SECRET)).toHaveLength(16);
  });

  it('encrypt/decrypt round-trips under the new key', () => {
    const { encrypt, decrypt } = createKeyHelpers(NEW_SECRET, OLD_SECRET);
    const ciphertext = encrypt('hello world');
    expect(decrypt(ciphertext)).toBe('hello world');
  });

  it('decrypt falls back to the old key for values still encrypted under it', () => {
    const oldHelpers = createKeyHelpers(OLD_SECRET, OLD_SECRET); // "old key is current" — simulates pre-rotation state
    const ciphertext = oldHelpers.encrypt('legacy value');
    const rotationHelpers = createKeyHelpers(NEW_SECRET, OLD_SECRET);
    expect(rotationHelpers.decrypt(ciphertext)).toBe('legacy value');
  });

  it('isOnNewKey distinguishes old-key from new-key ciphertext', () => {
    const oldHelpers = createKeyHelpers(OLD_SECRET, OLD_SECRET);
    const newHelpers = createKeyHelpers(NEW_SECRET, OLD_SECRET);
    const oldCiphertext = oldHelpers.encrypt('value');
    const newCiphertext = newHelpers.encrypt('value');
    expect(newHelpers.isOnNewKey(oldCiphertext)).toBe(false);
    expect(newHelpers.isOnNewKey(newCiphertext)).toBe(true);
  });

  it('searchable encryption is deterministic under a fixed key', () => {
    const { encrypt } = createKeyHelpers(NEW_SECRET, OLD_SECRET);
    expect(encrypt('user@example.com', true)).toBe(encrypt('user@example.com', true));
  });
});

describe('rotate-encryption-key: migrateModel', () => {
  it('re-encrypts fields still on the old key and skips fields already on the new key', async () => {
    const oldHelpers = createKeyHelpers(OLD_SECRET, OLD_SECRET);
    const newHelpers = createKeyHelpers(NEW_SECRET, OLD_SECRET);

    const db = [
      { id: 1, value: oldHelpers.encrypt('needs rotation') },
      { id: 2, value: newHelpers.encrypt('already rotated') },
    ];

    const updateRecord = vi.fn(async (id, updates) => {
      const record = db.find((r) => r.id === id);
      Object.assign(record, updates);
    });

    const result = await migrateModel({
      label: 'FakeModel.value',
      idField: 'id',
      fields: [{ name: 'value', searchable: false }],
      fetchBatch: async (cursor) => (cursor ? [] : db.map((r) => ({ ...r }))),
      updateRecord,
      keyHelpers: newHelpers,
    });

    expect(result).toMatchObject({ total: 2, migrated: 1, skipped: 1, failed: 0 });
    expect(updateRecord).toHaveBeenCalledTimes(1);
    expect(newHelpers.isOnNewKey(db[0].value)).toBe(true);
    expect(newHelpers.decrypt(db[0].value)).toBe('needs rotation');
  });

  it('dry-run does not call updateRecord', async () => {
    const oldHelpers = createKeyHelpers(OLD_SECRET, OLD_SECRET);
    const newHelpers = createKeyHelpers(NEW_SECRET, OLD_SECRET);
    const record = { id: 1, value: oldHelpers.encrypt('needs rotation') };
    const updateRecord = vi.fn();

    const result = await migrateModel({
      label: 'FakeModel.value',
      idField: 'id',
      fields: [{ name: 'value', searchable: false }],
      fetchBatch: async (cursor) => (cursor ? [] : [{ ...record }]),
      updateRecord,
      keyHelpers: newHelpers,
      dryRun: true,
    });

    expect(result.migrated).toBe(1);
    expect(updateRecord).not.toHaveBeenCalled();
  });
});

describe('rotate-encryption-key: run() drives every ROTATION_COVERAGE entry', () => {
  it('rotates every manifest field, including rawJson and merchantLabel, via an in-memory fake Prisma client', async () => {
    const oldHelpers = createKeyHelpers(OLD_SECRET, OLD_SECRET);

    const plaintextFor = (fieldName) => {
      if (fieldName === 'rawJson') return JSON.stringify({ ok: true, txn: 'sample' });
      if (fieldName === 'email') return 'user@example.com';
      return `${fieldName}-value`;
    };

    const tables = {};
    for (const entry of ROTATION_COVERAGE) {
      const row = { id: `${entry.prismaModel}-1` };
      for (const field of entry.fields) {
        row[field.name] = oldHelpers.encrypt(plaintextFor(field.name), field.searchable);
      }
      tables[entry.prismaModel] = [row];
    }

    const prisma = {};
    for (const [modelName, rows] of Object.entries(tables)) {
      prisma[modelName] = {
        findMany: async ({ cursor }) => (cursor ? [] : rows.map((r) => ({ ...r }))),
        update: async ({ where, data }) => {
          const row = rows.find((r) => r.id === where.id);
          Object.assign(row, data);
        },
      };
    }

    const totals = await run({ prisma, newSecret: NEW_SECRET, oldSecret: OLD_SECRET });

    expect(totals.failed).toBe(0);
    // migrated counts records needing an update (1 per manifest entry here), not fields —
    // Transaction has 2 fields on 1 record, so this is ROTATION_COVERAGE.length, not the field total.
    expect(totals.migrated).toBe(ROTATION_COVERAGE.length);

    const newHelpers = createKeyHelpers(NEW_SECRET, OLD_SECRET);
    for (const entry of ROTATION_COVERAGE) {
      const row = tables[entry.prismaModel][0];
      for (const field of entry.fields) {
        expect(newHelpers.isOnNewKey(row[field.name])).toBe(true);
        expect(newHelpers.decrypt(row[field.name])).toBe(plaintextFor(field.name));
      }
    }
  });
});
