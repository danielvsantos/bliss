import { describe, it, expect } from 'vitest';

import { computeDescriptionHash } from '../../../utils/descriptionHash.js';

describe('descriptionHash', () => {
  describe('computeDescriptionHash()', () => {
    it('returns a 64-char hex string', () => {
      const hash = computeDescriptionHash('Coffee Shop');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic (same input produces same output)', () => {
      const hash1 = computeDescriptionHash('Coffee Shop');
      const hash2 = computeDescriptionHash('Coffee Shop');
      expect(hash1).toBe(hash2);
    });

    it('different inputs produce different hashes', () => {
      const hash1 = computeDescriptionHash('Coffee Shop');
      const hash2 = computeDescriptionHash('Tea House');
      expect(hash1).not.toBe(hash2);
    });

    it('normalizes to lowercase', () => {
      const hash1 = computeDescriptionHash('COFFEE SHOP');
      const hash2 = computeDescriptionHash('coffee shop');
      expect(hash1).toBe(hash2);
    });

    it('normalizes by trimming whitespace', () => {
      const hash1 = computeDescriptionHash('  Coffee Shop  ');
      const hash2 = computeDescriptionHash('Coffee Shop');
      expect(hash1).toBe(hash2);
    });

    it('normalizes both lowercase and trim together', () => {
      const hash1 = computeDescriptionHash('  COFFEE SHOP  ');
      const hash2 = computeDescriptionHash('coffee shop');
      expect(hash1).toBe(hash2);
    });

    it('handles null gracefully', () => {
      const hash = computeDescriptionHash(null as any);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('handles undefined gracefully', () => {
      const hash = computeDescriptionHash(undefined as any);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('null and undefined produce the same hash', () => {
      const hash1 = computeDescriptionHash(null as any);
      const hash2 = computeDescriptionHash(undefined as any);
      expect(hash1).toBe(hash2);
    });

    it('handles empty string', () => {
      const hash = computeDescriptionHash('');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('empty string and null produce the same hash (both normalize to "")', () => {
      const hash1 = computeDescriptionHash('');
      const hash2 = computeDescriptionHash(null as any);
      expect(hash1).toBe(hash2);
    });
  });
});
