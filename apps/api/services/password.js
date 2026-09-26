import { randomBytes, scrypt, pbkdf2, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);
const pbkdf2Async = promisify(pbkdf2);

/**
 * Password hashing for Bliss.
 *
 * Why this module exists
 * ----------------------
 * The original implementation was PBKDF2-HMAC-SHA512 at **1,000 iterations**.
 * OWASP guidance for that construction is 210,000. Bliss's own encryption
 * module already uses 100,000 for key derivation — the codebase knew the right
 * order of magnitude and used 1% of it for the credential guarding everything
 * else. A stolen `User` table was cheap to crack offline.
 *
 * Why scrypt
 * ----------
 * It is built into Node. The dependency tree has no `bcrypt`/`node-gyp`, and
 * keeping it that way means the three Alpine images never need a compiler
 * toolchain. scrypt is memory-hard and OWASP-approved. argon2id is stronger
 * but would add a native build dependency to all three Dockerfiles.
 *
 * Storage format
 * --------------
 * A PHC-style string in the existing `User.passwordHash` column:
 *
 *   $scrypt$N=131072,r=8,p=1$<salt-base64>$<hash-base64>
 *
 * No Prisma migration is needed: `passwordHash` and `passwordSalt` are already
 * `String?`, the encryption middleware covers only `User.email`, and the
 * validation extension constrains only `User.name`.
 *
 * `passwordSalt` is set to `null` on new and upgraded rows. Format detection is
 * unambiguous: a leading `$` means scrypt; anything else is a legacy PBKDF2
 * hex digest that must be read together with `passwordSalt`.
 *
 * **Parameters are parsed from the stored string, never from the constants
 * below.** That is what makes a future work-factor bump a one-line change
 * rather than a second lockout — every existing hash stays verifiable.
 */

// Work factor. Hardcoded on purpose: no env var. The PHC string records the
// parameters per row, so raising or lowering these later still verifies every
// hash already in the database.
const SCRYPT_N = 131072; // 2^17
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/**
 * Node caps scrypt memory at 32 MiB unless `maxmem` is passed as a call
 * argument. At N=2^17, r=8 a single hash needs 128 × N × r = 128 MiB, so
 * WITHOUT this every login would throw ERR_CRYPTO_INVALID_SCRYPT_PARAM.
 * Doubled for headroom, and computed from the parameters actually in use so a
 * legacy hash with different parameters sizes its own budget correctly.
 *
 * Peak memory is structurally bounded: `apps/api` runs at Node's default
 * UV_THREADPOOL_SIZE of 4, so at most four hashes are ever in flight —
 * 4 × 128 MiB = 512 MiB. Size the API container with that ceiling in mind; a
 * host with less headroom than that should lower N rather than drop `maxmem`.
 */
function maxmemFor(N, r) {
  return 128 * N * r * 2;
}

const SCRYPT_PREFIX = '$scrypt$';

/** Legacy PBKDF2 parameters. Frozen — these describe rows already in the DB. */
const LEGACY_ITERATIONS = 1000;
const LEGACY_KEY_LENGTH = 64;
const LEGACY_DIGEST = 'sha512';

/**
 * Constant-time comparison, length-guarded.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and legacy
 * PBKDF2 digests and scrypt digests are different lengths. An unguarded
 * compare would therefore crash on exactly the rows this module exists to
 * keep working.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Hash a password with scrypt at the current work factor.
 *
 * Uses the async `crypto.scrypt` (libuv threadpool), never `scryptSync`, which
 * would block the event loop for ~100 ms per login.
 *
 * @param {string} password
 * @returns {Promise<string>} a PHC-style string for `User.passwordHash`
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('hashPassword requires a non-empty string');
  }

  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
  });

  return [
    '',
    'scrypt',
    `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * True when the stored hash is in the current scrypt format.
 * @param {string|null|undefined} storedHash
 */
export function isScryptHash(storedHash) {
  return typeof storedHash === 'string' && storedHash.startsWith(SCRYPT_PREFIX);
}

/**
 * True when a successful login should transparently re-hash this row.
 *
 * Idempotence (R3.4) is structural rather than a guard: anything already in
 * `$scrypt$` format returns false, so a second login is a no-op instead of a
 * re-encode.
 *
 * @param {string|null|undefined} storedHash
 */
export function needsRehash(storedHash) {
  if (!storedHash) return false;
  return !isScryptHash(storedHash);
}

/**
 * Parse a PHC-style scrypt string.
 * @returns {{ N: number, r: number, p: number, salt: Buffer, hash: Buffer }|null}
 *   null when the string is malformed — the caller treats that as "does not verify".
 */
function parseScrypt(storedHash) {
  // ['', 'scrypt', 'N=...,r=...,p=...', salt, hash]
  const parts = storedHash.split('$');
  if (parts.length !== 5 || parts[1] !== 'scrypt') return null;

  const params = {};
  for (const pair of parts[2].split(',')) {
    const [k, v] = pair.split('=');
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    params[k] = n;
  }
  if (!params.N || !params.r || !params.p) return null;

  const salt = Buffer.from(parts[3], 'base64');
  const hash = Buffer.from(parts[4], 'base64');
  if (salt.length === 0 || hash.length === 0) return null;

  return { N: params.N, r: params.r, p: params.p, salt, hash };
}

/**
 * Verify a password against either storage format.
 *
 * A legacy row that stops verifying is a total lockout for every pre-existing
 * user, so the legacy branch is not optional and is covered by its own tests.
 *
 * @param {string} password
 * @param {string|null|undefined} storedHash
 * @param {string|null|undefined} storedSalt Only meaningful for legacy rows.
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, storedHash, storedSalt) {
  if (typeof password !== 'string' || typeof storedHash !== 'string' || !storedHash) {
    return false;
  }

  if (isScryptHash(storedHash)) {
    const parsed = parseScrypt(storedHash);
    if (!parsed) return false;

    try {
      const derived = await scryptAsync(password, parsed.salt, parsed.hash.length, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
        maxmem: maxmemFor(parsed.N, parsed.r),
      });
      return safeEqual(derived, parsed.hash);
    } catch {
      // Malformed parameters (e.g. a non-power-of-two N) make scrypt throw.
      // That is a failed verification, not a 500.
      return false;
    }
  }

  // ─── Legacy: PBKDF2-HMAC-SHA512 @ 1,000 iterations, hex, separate salt ───
  if (typeof storedSalt !== 'string' || !storedSalt) return false;

  const derived = await pbkdf2Async(
    password,
    storedSalt,
    LEGACY_ITERATIONS,
    LEGACY_KEY_LENGTH,
    LEGACY_DIGEST,
  );

  return safeEqual(derived, Buffer.from(storedHash, 'hex'));
}

// Exported for tests and for the parameters-from-storage guarantee above.
export const SCRYPT_PARAMS = Object.freeze({
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  keyLength: KEY_LENGTH,
});
