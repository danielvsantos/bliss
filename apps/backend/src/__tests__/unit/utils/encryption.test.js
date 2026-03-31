// ENCRYPTION_SECRET is loaded from .env.test by setup/env.js before this module is required
const { encrypt, decrypt } = require('../../../utils/encryption');

describe('encryption', () => {
  describe('encrypt()', () => {
    it('returns null/undefined input unchanged', () => {
      expect(encrypt(null)).toBeNull();
      expect(encrypt(undefined)).toBeUndefined();
      expect(encrypt('')).toBe('');
    });

    it('returns a base64 string for valid input', () => {
      const result = encrypt('hello world');
      expect(typeof result).toBe('string');
      expect(() => Buffer.from(result, 'base64')).not.toThrow();
    });

    it('non-searchable encryption is non-deterministic (random IV)', () => {
      const a = encrypt('same text', false);
      const b = encrypt('same text', false);
      expect(a).not.toBe(b);
    });

    it('searchable encryption is deterministic (same input → same output)', () => {
      const a = encrypt('same text', true);
      const b = encrypt('same text', true);
      expect(a).toBe(b);
    });

    it('different inputs produce different ciphertexts (searchable)', () => {
      const a = encrypt('text one', true);
      const b = encrypt('text two', true);
      expect(a).not.toBe(b);
    });
  });

  describe('decrypt()', () => {
    it('returns null/undefined input unchanged', () => {
      expect(decrypt(null)).toBeNull();
      expect(decrypt(undefined)).toBeUndefined();
    });

    it('roundtrip: decrypt(encrypt(text)) === text', () => {
      const original = 'my secret value 123!';
      expect(decrypt(encrypt(original))).toBe(original);
    });

    it('roundtrip works for searchable encryption too', () => {
      const original = 'user@example.com';
      expect(decrypt(encrypt(original, true))).toBe(original);
    });

    it('returns plain text as-is when buffer is too short to be encrypted (legacy data)', () => {
      expect(decrypt('short')).toBe('short');
    });

    it('returns the original value on tampered ciphertext (graceful failure)', () => {
      const tampered = 'definitely-not-base64-encrypted-data!!!';
      expect(decrypt(tampered)).toBe(tampered);
    });
  });
});
