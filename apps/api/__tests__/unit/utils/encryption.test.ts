// Vitest loads .env.test via Vite's env handling before modules are imported,
// so ENCRYPTION_SECRET is available when encryption.js initializes.
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../../utils/encryption.js';

describe('encryption (finance-api)', () => {
  describe('encrypt()', () => {
    it('returns null/undefined input unchanged', () => {
      expect(encrypt(null as unknown as string)).toBeNull();
      expect(encrypt(undefined as unknown as string)).toBeUndefined();
      expect(encrypt('')).toBe('');
    });

    it('returns a base64 string for valid input', () => {
      const result = encrypt('hello world');
      expect(typeof result).toBe('string');
      expect(() => Buffer.from(result!, 'base64')).not.toThrow();
    });

    it('non-searchable encryption is non-deterministic', () => {
      const a = encrypt('same text', false);
      const b = encrypt('same text', false);
      expect(a).not.toBe(b);
    });

    it('searchable encryption is deterministic', () => {
      const a = encrypt('same text', true);
      const b = encrypt('same text', true);
      expect(a).toBe(b);
    });
  });

  describe('decrypt()', () => {
    it('returns null/undefined input unchanged', () => {
      expect(decrypt(null as unknown as string)).toBeNull();
      expect(decrypt(undefined as unknown as string)).toBeUndefined();
    });

    it('roundtrip: decrypt(encrypt(text)) === text', () => {
      const original = 'sensitive data 123';
      expect(decrypt(encrypt(original)!)).toBe(original);
    });

    it('roundtrip works for searchable encryption', () => {
      const original = 'user@example.com';
      expect(decrypt(encrypt(original, true)!)).toBe(original);
    });

    it('returns plain text as-is when too short to be encrypted (legacy data)', () => {
      expect(decrypt('short')).toBe('short');
    });

    it('returns original value on tampered ciphertext', () => {
      const tampered = 'this-is-not-valid-encrypted-data!!!';
      expect(decrypt(tampered)).toBe(tampered);
    });
  });
});
