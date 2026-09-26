#!/usr/bin/env node
/**
 * Email Normalization Migration
 *
 * Lowercases every `User.email` so stored rows match the canonical form the
 * application now writes and looks up (utils/normalizeEmail.js).
 *
 * Why this cannot be a SQL `LOWER()`
 * ----------------------------------
 * `User.email` is encrypted with `{ searchable: true }` — deterministic
 * encryption. The salt is `sha256(plaintext)[0:16]` and the IV is
 * `sha256(salt)[0:12]` (packages/shared/src/encryption.js), so the ciphertext
 * is a pure function of the exact plaintext bytes. A SQL `LOWER()` would
 * lowercase the *base64 ciphertext* and corrupt every row beyond recovery.
 *
 * Each row therefore has to be decrypted, lowercased, and re-encrypted. This
 * script carries its own self-contained crypto helpers rather than going
 * through the extended Prisma client, exactly as rotate-encryption-key.mjs
 * does — the client would decrypt on read and re-encrypt on write using the
 * value it was handed, which is precisely the transformation we need to
 * control by hand.
 *
 * Usage:
 *   node scripts/normalize-user-emails.mjs             # DRY RUN (the default)
 *   node scripts/normalize-user-emails.mjs --apply     # perform the writes
 *
 * Dry-run is the default and `--apply` is the opt-in — the inverse of
 * rotate-encryption-key.mjs's convention, deliberately, because a collision
 * here is destructive: `User.email` is `@unique`, so lowercasing two rows that
 * differ only in case would violate the index.
 *
 * Pre-flight: the script checks for case-insensitive duplicates BEFORE writing
 * anything. If any exist it reports them and exits non-zero, having written
 * nothing — a partially-applied migration would leave the table in a state
 * neither the old nor the new code understands.
 *
 * ENCRYPTION_SECRET must be the CURRENT key. If ENCRYPTION_SECRET_PREVIOUS is
 * still set from an in-flight rotation, finish the rotation first: this script
 * re-encrypts under ENCRYPTION_SECRET only, and running it mid-rotation would
 * write rows under a key the other service may not have yet.
 *
 * Idempotent: a second run reports zero rows needing change.
 */

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

// Crypto constants — must stay in sync with packages/shared/src/encryption.js
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const MIN_ENC_LENGTH = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;

function deriveKey(salt, secret) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(secret, salt, 100000, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Decrypt a stored value. Returns the input unchanged if it is not ciphertext. */
export async function decryptValue(encryptedText, secret) {
  if (!encryptedText) return encryptedText;

  const buffer = Buffer.from(encryptedText, 'base64');
  if (buffer.length < MIN_ENC_LENGTH) return encryptedText; // plaintext / legacy row

  const salt = buffer.subarray(0, SALT_LENGTH);
  const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = buffer.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = await deriveKey(salt, secret);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Encrypt a value the searchable (deterministic) way, as User.email is stored. */
export async function encryptSearchable(text, secret) {
  if (!text) return text;

  const textBuffer = Buffer.from(text, 'utf8');
  const salt = crypto.createHash('sha256').update(textBuffer).digest().subarray(0, SALT_LENGTH);
  const iv = crypto.createHash('sha256').update(salt).digest().subarray(0, IV_LENGTH);

  const key = await deriveKey(salt, secret);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');
}

/** The one canonical form. Must match apps/api/utils/normalizeEmail.js exactly. */
export function normalizeEmail(email) {
  if (typeof email !== 'string') return email;
  return email.trim().toLowerCase();
}

/**
 * Pure planning step, exported so it can be unit-tested without a database.
 *
 * @param {Array<{ id: string, email: string }>} rows decrypted rows
 * @returns {{ changes: Array<{id: string, from: string, to: string}>,
 *             duplicates: Array<{ normalized: string, ids: string[], originals: string[] }> }}
 */
export function planNormalization(rows) {
  const byNormalized = new Map();

  for (const row of rows) {
    const normalized = normalizeEmail(row.email);
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, []);
    byNormalized.get(normalized).push(row);
  }

  // User.email is @unique. Two rows that differ only in case would collide the
  // moment both are lowercased, so this aborts the whole run rather than
  // applying a partial migration and failing halfway.
  const duplicates = [];
  for (const [normalized, group] of byNormalized) {
    if (group.length > 1) {
      duplicates.push({
        normalized,
        ids: group.map((r) => r.id),
        originals: group.map((r) => r.email),
      });
    }
  }

  const changes = rows
    .filter((row) => normalizeEmail(row.email) !== row.email)
    .map((row) => ({ id: row.id, from: row.email, to: normalizeEmail(row.email) }));

  return { changes, duplicates };
}

/** Redact the local part so the log is useful without printing full addresses. */
function maskEmail(email) {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const secret = process.env.ENCRYPTION_SECRET;

  if (!secret) {
    console.error('ENCRYPTION_SECRET is required.');
    process.exit(1);
  }

  if (process.env.ENCRYPTION_SECRET_PREVIOUS) {
    console.error(
      'ENCRYPTION_SECRET_PREVIOUS is set, which means a key rotation is still in flight.\n' +
        'Finish the rotation (see docs/guides/key-rotation.md) before running this script —\n' +
        'it re-encrypts under ENCRYPTION_SECRET only.',
    );
    process.exit(1);
  }

  console.log(apply ? '=== APPLY MODE — rows will be written ===' : '=== DRY RUN (no writes) ===');

  const prisma = new PrismaClient();

  try {
    // Raw query: the extended client would decrypt on read, and we need the
    // ciphertext boundary under our own control.
    const raw = await prisma.$queryRaw`SELECT id, email FROM "User"`;

    const rows = [];
    const undecryptable = [];
    for (const row of raw) {
      try {
        rows.push({ id: row.id, email: await decryptValue(row.email, secret) });
      } catch {
        undecryptable.push(row.id);
      }
    }

    if (undecryptable.length > 0) {
      console.error(
        `\n${undecryptable.length} row(s) could not be decrypted with the current ` +
          'ENCRYPTION_SECRET. Aborting without writing anything.',
      );
      console.error('  ids:', undecryptable.join(', '));
      process.exit(1);
    }

    const { changes, duplicates } = planNormalization(rows);

    console.log(`\nScanned ${rows.length} user row(s).`);

    if (duplicates.length > 0) {
      console.error(
        `\nABORTING: ${duplicates.length} case-insensitive duplicate group(s) found. ` +
          'User.email is UNIQUE, so lowercasing these would violate the index.',
      );
      for (const dup of duplicates) {
        console.error(
          `  ${maskEmail(dup.normalized)} <- ${dup.originals.map(maskEmail).join(', ')} ` +
            `(ids: ${dup.ids.join(', ')})`,
        );
      }
      console.error('\nNothing was written. Resolve the duplicates, then re-run.');
      process.exit(1);
    }

    console.log(`${changes.length} row(s) need normalization.`);
    for (const change of changes) {
      console.log(`  ${change.id}: ${maskEmail(change.from)} -> ${maskEmail(change.to)}`);
    }

    if (changes.length === 0) {
      console.log('\nNothing to do. (This is the expected result on an already-normalized DB.)');
      return;
    }

    if (!apply) {
      console.log('\nDry run complete. Re-run with --apply to write these changes.');
      return;
    }

    let written = 0;
    for (const change of changes) {
      const ciphertext = await encryptSearchable(change.to, secret);
      await prisma.$executeRaw`UPDATE "User" SET email = ${ciphertext} WHERE id = ${change.id}`;
      written += 1;
    }

    console.log(`\nDone. ${written} row(s) updated.`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly, so the exported helpers stay importable
// from tests without triggering a database connection.
if (process.argv[1] && process.argv[1].endsWith('normalize-user-emails.mjs')) {
  main().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}
