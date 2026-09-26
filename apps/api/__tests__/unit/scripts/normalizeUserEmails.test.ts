import { describe, it, expect } from 'vitest';

import {
  planNormalization,
  normalizeEmail,
  encryptSearchable,
  decryptValue,
} from '../../../scripts/normalize-user-emails.mjs';

const SECRET = 'test-secret-that-is-exactly-32-by';

describe('normalize-user-emails migration', () => {
  describe('planNormalization', () => {
    it('reports zero changes for an already-normalized set (the expected case)', () => {
      const { changes, duplicates } = planNormalization([
        { id: '1', email: 'a@example.com' },
        { id: '2', email: 'b@example.com' },
      ]);

      expect(changes).toHaveLength(0);
      expect(duplicates).toHaveLength(0);
    });

    it('counts only the rows that actually change', () => {
      const { changes } = planNormalization([
        { id: '1', email: 'Already@Example.com' },
        { id: '2', email: 'lower@example.com' },
        { id: '3', email: '  padded@example.com  ' },
      ]);

      expect(changes.map((c) => c.id).sort()).toEqual(['1', '3']);
      expect(changes.find((c) => c.id === '1')!.to).toBe('already@example.com');
      expect(changes.find((c) => c.id === '3')!.to).toBe('padded@example.com');
    });

    // User.email is @unique, so lowercasing two rows that differ only in case
    // would violate the index. The run must abort with a report rather than
    // apply a partial migration and fail halfway.
    it('detects case-insensitive duplicates and names both rows', () => {
      const { duplicates } = planNormalization([
        { id: '1', email: 'A@x.com' },
        { id: '2', email: 'a@x.com' },
        { id: '3', email: 'other@x.com' },
      ]);

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].normalized).toBe('a@x.com');
      expect(duplicates[0].ids.sort()).toEqual(['1', '2']);
      expect(duplicates[0].originals.sort()).toEqual(['A@x.com', 'a@x.com']);
    });

    it('detects a three-way duplicate group', () => {
      const { duplicates } = planNormalization([
        { id: '1', email: 'A@x.com' },
        { id: '2', email: 'a@x.com' },
        { id: '3', email: 'A@X.com' },
      ]);

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].ids).toHaveLength(3);
    });

    it('is idempotent — re-planning the applied result yields no changes', () => {
      const rows = [
        { id: '1', email: 'Mixed@Example.com' },
        { id: '2', email: 'lower@example.com' },
      ];
      const first = planNormalization(rows);
      expect(first.changes).toHaveLength(1);

      const applied = rows.map((r) => ({ id: r.id, email: normalizeEmail(r.email) as string }));
      expect(planNormalization(applied).changes).toHaveLength(0);
    });

    it('handles an empty table', () => {
      const { changes, duplicates } = planNormalization([]);
      expect(changes).toHaveLength(0);
      expect(duplicates).toHaveLength(0);
    });
  });

  describe('normalizeEmail', () => {
    it('matches the application-side helper: trim + lowercase only', () => {
      expect(normalizeEmail('  A.B+tag@Example.COM ')).toBe('a.b+tag@example.com');
    });

    it('does not strip dots or plus-tags — those change identity semantics', () => {
      expect(normalizeEmail('a.b+tag@example.com')).toBe('a.b+tag@example.com');
    });
  });

  describe('crypto helpers', () => {
    // The whole reason this script exists instead of a SQL LOWER(): the
    // ciphertext is a pure function of the exact plaintext bytes.
    it('produces a deterministic ciphertext for a given plaintext', async () => {
      const a = await encryptSearchable('user@example.com', SECRET);
      const b = await encryptSearchable('user@example.com', SECRET);
      expect(a).toBe(b);
    });

    it('produces a completely different ciphertext for a case variant', async () => {
      const lower = await encryptSearchable('user@example.com', SECRET);
      const upper = await encryptSearchable('User@Example.com', SECRET);
      expect(lower).not.toBe(upper);
    });

    it('round-trips decrypt(encrypt(x)) === x', async () => {
      const ciphertext = await encryptSearchable('Mixed@Example.com', SECRET);
      expect(await decryptValue(ciphertext, SECRET)).toBe('Mixed@Example.com');
    });

    it('normalizing then re-encrypting yields the ciphertext the app will look up', async () => {
      const stored = await encryptSearchable('Mixed@Example.com', SECRET);
      const plaintext = (await decryptValue(stored, SECRET)) as string;
      const rewritten = await encryptSearchable(normalizeEmail(plaintext) as string, SECRET);

      expect(rewritten).toBe(await encryptSearchable('mixed@example.com', SECRET));
    });

    it('passes through empty and non-ciphertext values unchanged', async () => {
      expect(await decryptValue('', SECRET)).toBe('');
      expect(await decryptValue(null, SECRET)).toBeNull();
      expect(await encryptSearchable('', SECRET)).toBe('');
    });
  });
});
