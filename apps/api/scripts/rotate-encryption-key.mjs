#!/usr/bin/env node
/**
 * Encryption Secret Rotation Migration
 *
 * Re-encrypts all sensitive fields in the database under a new ENCRYPTION_SECRET.
 * Run this AFTER setting ENCRYPTION_SECRET to the new key and
 * ENCRYPTION_SECRET_PREVIOUS to the old key in your environment.
 *
 * Field coverage is driven by apps/api/scripts/lib/encryptionRotationCoverage.mjs
 * (the same manifest verify-encryption-key.mjs and the coverage-guard test use),
 * so adding a newly-encrypted field to that manifest is enough to bring it into
 * this script too.
 *
 * Full procedure: docs/guides/key-rotation.md §2.
 *
 * Usage:
 *   ENCRYPTION_SECRET=<new> ENCRYPTION_SECRET_PREVIOUS=<old> node scripts/rotate-encryption-key.mjs
 *   ENCRYPTION_SECRET=<new> ENCRYPTION_SECRET_PREVIOUS=<old> node scripts/rotate-encryption-key.mjs --dry-run
 *
 * After successful migration (zero failures):
 *   1. Run scripts/verify-encryption-key.mjs — it must report 0 undecryptable rows
 *   2. Remove ENCRYPTION_SECRET_PREVIOUS from all environment configs
 *   3. Restart both services
 */

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { encryptedFields } from '@bliss/shared/encryption';
import { ROTATION_COVERAGE, assertCoverageComplete } from './lib/encryptionRotationCoverage.mjs';

const BATCH_SIZE = 100;

// Crypto constants — must stay in sync with utils/encryption.js
const ALGORITHM        = 'aes-256-gcm';
const IV_LENGTH        = 12;
const AUTH_TAG_LENGTH  = 16;
const SALT_LENGTH      = 16;
const MIN_ENC_LENGTH   = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;

// ─── Crypto helpers (self-contained — no dependency on the module singleton) ──

function deriveKey(salt, secret) {
  return crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha256');
}

/** Attempt to decrypt with a specific secret. Throws on auth-tag failure. */
function tryDecrypt(encryptedText, secret) {
  const buffer = Buffer.from(encryptedText, 'base64');
  if (buffer.length < MIN_ENC_LENGTH) return encryptedText; // plain text / legacy

  const salt      = buffer.subarray(0, SALT_LENGTH);
  const iv        = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag   = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(salt, secret);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Encrypt a value with the given secret. */
function encryptWith(text, isSearchable, secret) {
  if (!text) return text;

  let salt, iv;
  if (isSearchable) {
    const textBuffer = Buffer.from(text, 'utf8');
    salt = crypto.createHash('sha256').update(textBuffer).digest().subarray(0, SALT_LENGTH);
    iv   = crypto.createHash('sha256').update(salt).digest().subarray(0, IV_LENGTH);
  } else {
    salt = crypto.randomBytes(SALT_LENGTH);
    iv   = crypto.randomBytes(IV_LENGTH);
  }

  const key     = deriveKey(salt, secret);
  const cipher  = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');
}

export function keyFingerprint(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/**
 * Builds decrypt/encrypt/isOnNewKey helpers bound to a specific (newSecret, oldSecret) pair.
 * Exported so unit tests can exercise the pure crypto behaviour without a database.
 */
export function createKeyHelpers(newSecret, oldSecret) {
  function decrypt(encryptedText) {
    try {
      return tryDecrypt(encryptedText, newSecret);
    } catch {
      return tryDecrypt(encryptedText, oldSecret); // throws if both fail
    }
  }

  function isOnNewKey(encryptedText) {
    if (!encryptedText) return true;
    try {
      tryDecrypt(encryptedText, newSecret);
      return true;
    } catch {
      return false;
    }
  }

  function encrypt(text, isSearchable = false) {
    return encryptWith(text, isSearchable, newSecret);
  }

  return { decrypt, isOnNewKey, encrypt };
}

// ─── Migration logic ──────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}   opts.label       - Human-readable model name for logging
 * @param {Function} opts.fetchBatch  - (cursor) => Promise<record[]>
 * @param {string}   opts.idField     - Primary key field name
 * @param {Array}    opts.fields      - [{ name, searchable }]
 * @param {Function} opts.updateRecord - (id, updates) => Promise<void>
 * @param {object}   opts.keyHelpers  - { decrypt, isOnNewKey, encrypt } from createKeyHelpers()
 * @param {boolean}  [opts.dryRun]
 */
export async function migrateModel({ label, fetchBatch, idField, fields, updateRecord, keyHelpers, dryRun = false }) {
  const { decrypt, isOnNewKey, encrypt } = keyHelpers;
  let cursor   = undefined;
  let total    = 0;
  let migrated = 0;
  let skipped  = 0;
  let failed   = 0;

  process.stdout.write(`\nMigrating ${label}...\n`);

  while (true) {
    const records = await fetchBatch(cursor);
    if (records.length === 0) break;

    cursor = records[records.length - 1][idField];
    total += records.length;

    for (const record of records) {
      const updates  = {};
      let needsUpdate = false;

      for (const field of fields) {
        const value = record[field.name];
        if (!value) continue;

        // Skip fields already encrypted with the new key
        if (isOnNewKey(value)) {
          skipped++;
          continue;
        }

        try {
          const plaintext = decrypt(value);
          updates[field.name] = encrypt(plaintext, field.searchable);
          needsUpdate = true;
        } catch (err) {
          console.error(`  FAILED ${label}#${record[idField]}.${field.name}: ${err.message}`);
          failed++;
        }
      }

      if (needsUpdate) {
        if (!dryRun) {
          await updateRecord(record[idField], updates);
        }
        migrated++;
      }
    }

    process.stdout.write(
      `  ${total} processed — ${migrated} migrated, ${skipped} already current, ${failed} failed\r`
    );

    if (records.length < BATCH_SIZE) break;
  }

  process.stdout.write('\n');
  console.log(`  Done: ${total} total | ${migrated} migrated | ${skipped} already current | ${failed} failed`);

  return { label, total, migrated, skipped, failed };
}

/** Maps a ROTATION_COVERAGE entry to a migrateModel() fetchBatch/updateRecord pair for the given Prisma client. */
function buildJobFromCoverageEntry(entry, prisma, keyHelpers, dryRun) {
  const select = { [entry.idField]: true };
  for (const field of entry.fields) select[field.name] = true;

  return {
    label: entry.label,
    idField: entry.idField,
    fields: entry.fields,
    keyHelpers,
    dryRun,
    fetchBatch: (cursor) => prisma[entry.prismaModel].findMany({
      take: BATCH_SIZE,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { [entry.idField]: cursor } : undefined,
      select,
      orderBy: entry.orderBy,
    }),
    updateRecord: (id, data) => prisma[entry.prismaModel].update({
      where: { [entry.idField]: id },
      data,
    }),
  };
}

/**
 * Runs the full rotation against a live Prisma client. Exported (rather than
 * executed automatically on import) so tests can drive migrateModel() in
 * isolation without a database, and so this module is side-effect-free when
 * imported.
 */
export async function run({ prisma, newSecret, oldSecret, dryRun = false }) {
  assertCoverageComplete(encryptedFields);

  const keyHelpers = createKeyHelpers(newSecret, oldSecret);
  const newFp = keyFingerprint(newSecret);
  const oldFp = keyFingerprint(oldSecret);

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     Bliss — Encryption Key Rotation Migration    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  if (dryRun) {
    console.log('[DRY RUN] No changes will be written to the database.\n');
  }
  console.log(`New key fingerprint (SHA-256 prefix): ${newFp}...`);
  console.log(`Old key fingerprint (SHA-256 prefix): ${oldFp}...`);

  const results = [];
  for (const entry of ROTATION_COVERAGE) {
    results.push(await migrateModel(buildJobFromCoverageEntry(entry, prisma, keyHelpers, dryRun)));
  }

  const totals = results.reduce(
    (acc, r) => ({
      total:    acc.total    + r.total,
      migrated: acc.migrated + r.migrated,
      skipped:  acc.skipped  + r.skipped,
      failed:   acc.failed   + r.failed,
    }),
    { total: 0, migrated: 0, skipped: 0, failed: 0 }
  );

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║                 Migration Summary                ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Total records processed : ${totals.total}`);
  console.log(`  Re-encrypted            : ${totals.migrated}`);
  console.log(`  Already on new key      : ${totals.skipped}`);
  console.log(`  Failed                  : ${totals.failed}`);

  if (dryRun) {
    console.log('\n[DRY RUN] Re-run without --dry-run to apply these changes.');
  } else if (totals.failed > 0) {
    console.error(`\nWARNING: ${totals.failed} field(s) could not be migrated.`);
    console.error('Investigate the errors above before running verify-encryption-key.mjs.');
  } else {
    console.log('\n✓ Migration complete. Next steps:');
    console.log('  1. node apps/api/scripts/verify-encryption-key.mjs — must report 0 undecryptable rows');
    console.log('  2. Remove ENCRYPTION_SECRET_PREVIOUS from all environment configs');
    console.log('     (Vercel, Railway, or wherever your services are hosted)');
    console.log('  3. Restart both bliss-finance-api and bliss-backend-service');
  }

  return totals;
}

// ─── CLI entry point (guarded so importing this module has no side effects) ──

async function main() {
  const newSecret = process.env.ENCRYPTION_SECRET;
  const oldSecret = process.env.ENCRYPTION_SECRET_PREVIOUS;
  const dryRun = process.argv.includes('--dry-run');

  if (!newSecret) {
    console.error('ERROR: ENCRYPTION_SECRET (new key) is required');
    process.exit(1);
  }
  if (!oldSecret) {
    console.error('ERROR: ENCRYPTION_SECRET_PREVIOUS (old key) is required');
    process.exit(1);
  }
  if (newSecret === oldSecret) {
    console.error('ERROR: ENCRYPTION_SECRET and ENCRYPTION_SECRET_PREVIOUS are identical — nothing to do.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const totals = await run({ prisma, newSecret, oldSecret, dryRun });
    if (!dryRun && totals.failed > 0) {
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error('\nMigration aborted:', err.message);
    process.exit(1);
  });
}
