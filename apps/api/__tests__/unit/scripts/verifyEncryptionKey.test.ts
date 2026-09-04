import { describe, it, expect } from 'vitest';
import { verifyModel, run, tryDecryptStrict, keyFingerprint } from '../../../scripts/verify-encryption-key.mjs';
import { createKeyHelpers } from '../../../scripts/rotate-encryption-key.mjs';
import { ROTATION_COVERAGE } from '../../../scripts/lib/encryptionRotationCoverage.mjs';

const NEW_SECRET = 'new-secret-for-verify-tests';
const OLD_SECRET = 'old-secret-for-verify-tests';

describe('verify-encryption-key: tryDecryptStrict / keyFingerprint', () => {
  it('throws on ciphertext encrypted under a different key', () => {
    const { encrypt } = createKeyHelpers(OLD_SECRET, OLD_SECRET);
    const ciphertext = encrypt('secret value');
    expect(() => tryDecryptStrict(ciphertext, NEW_SECRET)).toThrow();
  });

  it('decrypts ciphertext encrypted under the matching key', () => {
    const { encrypt } = createKeyHelpers(NEW_SECRET, OLD_SECRET);
    const ciphertext = encrypt('secret value');
    expect(tryDecryptStrict(ciphertext, NEW_SECRET)).toBe('secret value');
  });

  it('fingerprint is a stable 16-char prefix', () => {
    expect(keyFingerprint(NEW_SECRET)).toBe(keyFingerprint(NEW_SECRET));
    expect(keyFingerprint(NEW_SECRET)).toHaveLength(16);
  });
});

describe('verify-encryption-key: verifyModel', () => {
  it('reports 0 undecryptable/insane when every row is on the new key and sane', async () => {
    const { encrypt } = createKeyHelpers(NEW_SECRET, OLD_SECRET);
    const rows = [{ id: 1, email: encrypt('user@example.com', true) }];

    const result = await verifyModel({
      label: 'FakeModel.email',
      idField: 'id',
      fields: [{ name: 'email', sanity: (v) => v.includes('@') }],
      secret: NEW_SECRET,
      fetchBatch: async (cursor) => (cursor ? [] : rows),
    });

    expect(result).toMatchObject({ scanned: 1, ok: 1, undecryptable: 0, insane: 0 });
  });

  it('counts a row still on the old key as undecryptable', async () => {
    const oldHelpers = createKeyHelpers(OLD_SECRET, OLD_SECRET);
    const rows = [{ id: 1, email: oldHelpers.encrypt('user@example.com', true) }];

    const result = await verifyModel({
      label: 'FakeModel.email',
      idField: 'id',
      fields: [{ name: 'email', sanity: (v) => v.includes('@') }],
      secret: NEW_SECRET,
      fetchBatch: async (cursor) => (cursor ? [] : rows),
    });

    expect(result.undecryptable).toBe(1);
    expect(result.ok).toBe(0);
    expect(result.problems[0]).toMatch(/undecryptable/);
  });

  it('counts a row that decrypts but fails the sanity check as insane', async () => {
    const { encrypt } = createKeyHelpers(NEW_SECRET, OLD_SECRET);
    // Simulates the rawJson gap: decrypts fine, but the plaintext isn't valid JSON.
    const rows = [{ id: 1, rawJson: encrypt('not valid json') }];

    const result = await verifyModel({
      label: 'PlaidTransaction.rawJson',
      idField: 'id',
      fields: [{ name: 'rawJson', sanity: (v) => { try { JSON.parse(v); return true; } catch { return false; } } }],
      secret: NEW_SECRET,
      fetchBatch: async (cursor) => (cursor ? [] : rows),
    });

    expect(result.insane).toBe(1);
    expect(result.ok).toBe(0);
    expect(result.problems[0]).toMatch(/sanity/);
  });
});

describe('verify-encryption-key: run() never reads ENCRYPTION_SECRET_PREVIOUS', () => {
  it('fails a row still on the old key even when ENCRYPTION_SECRET_PREVIOUS is set in the environment', async () => {
    const previousBackup = process.env.ENCRYPTION_SECRET_PREVIOUS;
    process.env.ENCRYPTION_SECRET_PREVIOUS = OLD_SECRET; // must be ignored by run()

    try {
      const oldHelpers = createKeyHelpers(OLD_SECRET, OLD_SECRET);
      const tables = {};
      for (const entry of ROTATION_COVERAGE) {
        const row = { id: `${entry.prismaModel}-1` };
        for (const field of entry.fields) {
          const plaintext = field.name === 'rawJson' ? JSON.stringify({ ok: true }) : field.name === 'email' ? 'user@example.com' : `${field.name}-value`;
          row[field.name] = oldHelpers.encrypt(plaintext, field.searchable);
        }
        tables[entry.prismaModel] = [row];
      }

      const prisma = {};
      for (const [modelName, rows] of Object.entries(tables)) {
        prisma[modelName] = {
          findMany: async ({ cursor }) => (cursor ? [] : rows.map((r) => ({ ...r }))),
        };
      }

      const totals = await run({ prisma, secret: NEW_SECRET });

      // Every row is still on the OLD key, so verifying against NEW_SECRET must fail all of them.
      const expectedFieldCount = ROTATION_COVERAGE.reduce((n, e) => n + e.fields.length, 0);
      expect(totals.undecryptable).toBe(expectedFieldCount);
      expect(totals.ok).toBe(0);
    } finally {
      if (previousBackup === undefined) delete process.env.ENCRYPTION_SECRET_PREVIOUS;
      else process.env.ENCRYPTION_SECRET_PREVIOUS = previousBackup;
    }
  });

  it('reports 0 undecryptable/insane once every row is on the new key', async () => {
    const newHelpers = createKeyHelpers(NEW_SECRET, OLD_SECRET);
    const tables = {};
    for (const entry of ROTATION_COVERAGE) {
      const row = { id: `${entry.prismaModel}-1` };
      for (const field of entry.fields) {
        const plaintext = field.name === 'rawJson' ? JSON.stringify({ ok: true }) : field.name === 'email' ? 'user@example.com' : `${field.name}-value`;
        row[field.name] = newHelpers.encrypt(plaintext, field.searchable);
      }
      tables[entry.prismaModel] = [row];
    }

    const prisma = {};
    for (const [modelName, rows] of Object.entries(tables)) {
      prisma[modelName] = {
        findMany: async ({ cursor }) => (cursor ? [] : rows.map((r) => ({ ...r }))),
      };
    }

    const totals = await run({ prisma, secret: NEW_SECRET });

    expect(totals.undecryptable).toBe(0);
    expect(totals.insane).toBe(0);
  });
});
