import { describe, it, expect } from 'vitest';
import { randomBytes, pbkdf2Sync } from 'crypto';

import {
  hashPassword,
  verifyPassword,
  needsRehash,
  isScryptHash,
  SCRYPT_PARAMS,
} from '../../../services/password.js';

/**
 * Builds a row exactly as the pre-remediation code wrote it:
 * PBKDF2-HMAC-SHA512, 1,000 iterations, 64 bytes, hex digest, hex salt in a
 * separate column. Every existing user in every instance looks like this, so
 * it is the fixture that matters most in this file.
 */
function legacyRow(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { passwordHash: hash, passwordSalt: salt };
}

describe('password (scrypt)', () => {
  describe('hashPassword', () => {
    it('produces a PHC-style string carrying its own parameters', async () => {
      const hash = await hashPassword('correct horse battery staple');

      expect(hash.startsWith('$scrypt$')).toBe(true);
      expect(hash.split('$')).toHaveLength(5);
      expect(hash).toContain(`N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`);
    });

    it('produces a different hash each time (random salt)', async () => {
      const a = await hashPassword('same-password');
      const b = await hashPassword('same-password');
      expect(a).not.toBe(b);
    });

    it('rejects an empty or non-string password', async () => {
      await expect(hashPassword('')).rejects.toThrow();
      // @ts-expect-error deliberately wrong type
      await expect(hashPassword(undefined)).rejects.toThrow();
    });
  });

  describe('verifyPassword — scrypt round-trip', () => {
    it('accepts the correct password', async () => {
      const hash = await hashPassword('s3cure-pw');
      expect(await verifyPassword('s3cure-pw', hash, null)).toBe(true);
    });

    it('rejects the wrong password', async () => {
      const hash = await hashPassword('s3cure-pw');
      expect(await verifyPassword('s3cure-pwX', hash, null)).toBe(false);
      expect(await verifyPassword('', hash, null)).toBe(false);
    });

    it('rejects a tampered digest', async () => {
      const hash = await hashPassword('s3cure-pw');
      const parts = hash.split('$');
      const flipped = Buffer.from(parts[4], 'base64');
      flipped[0] ^= 0xff;
      parts[4] = flipped.toString('base64');

      expect(await verifyPassword('s3cure-pw', parts.join('$'), null)).toBe(false);
    });

    it('rejects a tampered salt', async () => {
      const hash = await hashPassword('s3cure-pw');
      const parts = hash.split('$');
      parts[3] = randomBytes(16).toString('base64');

      expect(await verifyPassword('s3cure-pw', parts.join('$'), null)).toBe(false);
    });

    // Parameters come from the stored string, never from the current
    // constants — that is what makes a future work-factor bump a one-line
    // change rather than a second lockout.
    it('verifies a hash stored with different parameters than the current ones', async () => {
      // A hash produced at a deliberately lower work factor, as an older (or
      // newer) deployment would have written it.
      const { scrypt } = await import('crypto');
      const { promisify } = await import('util');
      const scryptAsync = promisify(scrypt) as (
        p: string,
        s: Buffer,
        l: number,
        o: object,
      ) => Promise<Buffer>;

      const salt = randomBytes(16);
      const N = 16384;
      const derived = await scryptAsync('old-params-pw', salt, 64, {
        N,
        r: 8,
        p: 1,
        maxmem: 128 * N * 8 * 2,
      });
      const stored = `$scrypt$N=${N},r=8,p=1$${salt.toString('base64')}$${derived.toString('base64')}`;

      expect(await verifyPassword('old-params-pw', stored, null)).toBe(true);
      expect(await verifyPassword('wrong', stored, null)).toBe(false);
    });
  });

  describe('verifyPassword — legacy PBKDF2-1,000', () => {
    // A legacy row that stops verifying is a total lockout for every
    // pre-existing user on every instance.
    it('accepts the correct password against a legacy row', async () => {
      const row = legacyRow('legacy-password');
      expect(await verifyPassword('legacy-password', row.passwordHash, row.passwordSalt)).toBe(
        true,
      );
    });

    it('rejects the wrong password against a legacy row', async () => {
      const row = legacyRow('legacy-password');
      expect(await verifyPassword('nope', row.passwordHash, row.passwordSalt)).toBe(false);
    });

    it('rejects a legacy row whose salt is missing', async () => {
      const row = legacyRow('legacy-password');
      expect(await verifyPassword('legacy-password', row.passwordHash, null)).toBe(false);
      expect(await verifyPassword('legacy-password', row.passwordHash, '')).toBe(false);
    });
  });

  describe('never throws on malformed input', () => {
    // Legacy and scrypt digests are different lengths, so an unguarded
    // timingSafeEqual would throw on exactly the rows this module exists to
    // keep working — a 500 instead of a 401.
    it('returns false rather than throwing for mismatched digest lengths', async () => {
      const scryptHash = await hashPassword('pw');
      const legacy = legacyRow('pw');

      // Legacy hash fed through the scrypt path and vice versa.
      await expect(verifyPassword('pw', scryptHash, legacy.passwordSalt)).resolves.toBe(true);
      await expect(verifyPassword('pw', 'abcd', legacy.passwordSalt)).resolves.toBe(false);
    });

    it.each([
      ['empty hash', ''],
      ['garbage', 'not-a-hash'],
      ['scrypt prefix, no fields', '$scrypt$'],
      ['too few fields', '$scrypt$N=16384,r=8,p=1$onlysalt'],
      ['unknown algorithm', '$argon2id$v=19$m=65536$abc$def'],
      ['non-numeric parameters', '$scrypt$N=abc,r=8,p=1$c2FsdA==$aGFzaA=='],
      ['missing parameters', '$scrypt$r=8$c2FsdA==$aGFzaA=='],
      ['empty salt', '$scrypt$N=16384,r=8,p=1$$aGFzaA=='],
      ['invalid N (not a power of two)', '$scrypt$N=12345,r=8,p=1$c2FsdA==$aGFzaA=='],
    ])('returns false for %s', async (_label, stored) => {
      await expect(verifyPassword('pw', stored, 'somesalt')).resolves.toBe(false);
    });

    it.each([
      ['null hash', null],
      ['undefined hash', undefined],
      ['numeric hash', 123],
    ])('returns false for %s', async (_label, stored) => {
      // @ts-expect-error deliberately wrong types
      await expect(verifyPassword('pw', stored, 'salt')).resolves.toBe(false);
    });

    it('returns false for a non-string password', async () => {
      const hash = await hashPassword('pw');
      // @ts-expect-error deliberately wrong type
      await expect(verifyPassword(undefined, hash, null)).resolves.toBe(false);
    });
  });

  describe('needsRehash / isScryptHash truth table', () => {
    it('is false for a current scrypt hash', async () => {
      const hash = await hashPassword('pw');
      expect(isScryptHash(hash)).toBe(true);
      expect(needsRehash(hash)).toBe(false);
    });

    it('is true for a legacy PBKDF2 hash', () => {
      const row = legacyRow('pw');
      expect(isScryptHash(row.passwordHash)).toBe(false);
      expect(needsRehash(row.passwordHash)).toBe(true);
    });

    it('is false for an absent hash (OAuth-only account)', () => {
      expect(needsRehash(null)).toBe(false);
      expect(needsRehash(undefined)).toBe(false);
      expect(needsRehash('')).toBe(false);
    });
  });
});
