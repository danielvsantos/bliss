#!/usr/bin/env node
/**
 * Encryption Secret Rotation Migration
 *
 * Re-encrypts all sensitive fields in the database under a new ENCRYPTION_SECRET.
 * Run this AFTER setting ENCRYPTION_SECRET to the new key and
 * ENCRYPTION_SECRET_PREVIOUS to the old key in your environment.
 *
 * Usage:
 *   ENCRYPTION_SECRET=<new> ENCRYPTION_SECRET_PREVIOUS=<old> node scripts/rotate-encryption-key.mjs
 *   ENCRYPTION_SECRET=<new> ENCRYPTION_SECRET_PREVIOUS=<old> node scripts/rotate-encryption-key.mjs --dry-run
 *
 * After successful migration (zero failures):
 *   1. Verify the app works correctly
 *   2. Remove ENCRYPTION_SECRET_PREVIOUS from all environment configs
 *   3. Restart both services
 */

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

// ─── Configuration ────────────────────────────────────────────────────────────

const NEW_SECRET = process.env.ENCRYPTION_SECRET;
const OLD_SECRET = process.env.ENCRYPTION_SECRET_PREVIOUS;
const DRY_RUN    = process.argv.includes('--dry-run');
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

/** Decrypt using NEW key first; fall back to OLD key. */
function decrypt(encryptedText) {
  try {
    return tryDecrypt(encryptedText, NEW_SECRET);
  } catch {
    return tryDecrypt(encryptedText, OLD_SECRET); // throws if both fail
  }
}

/** Returns true if the value can already be decrypted with the new key. */
function isOnNewKey(encryptedText) {
  if (!encryptedText) return true;
  try {
    tryDecrypt(encryptedText, NEW_SECRET);
    return true;
  } catch {
    return false;
  }
}

/** Encrypt a value with the new secret. */
function encrypt(text, isSearchable = false) {
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

  const key     = deriveKey(salt, NEW_SECRET);
  const cipher  = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');
}

// ─── Migration logic ──────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}   opts.label     - Human-readable model name for logging
 * @param {Function} opts.fetchBatch - (cursor) => Promise<record[]>
 * @param {string}   opts.idField   - Primary key field name
 * @param {Array}    opts.fields    - [{ name, searchable }]
 * @param {Function} opts.updateRecord - (id, updates) => Promise<void>
 */
async function migrateModel({ label, fetchBatch, idField, fields, updateRecord }) {
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
        if (!DRY_RUN) {
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

  return { total, migrated, skipped, failed };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Validate inputs
  if (!NEW_SECRET) {
    console.error('ERROR: ENCRYPTION_SECRET (new key) is required');
    process.exit(1);
  }
  if (!OLD_SECRET) {
    console.error('ERROR: ENCRYPTION_SECRET_PREVIOUS (old key) is required');
    process.exit(1);
  }
  if (NEW_SECRET === OLD_SECRET) {
    console.error('ERROR: ENCRYPTION_SECRET and ENCRYPTION_SECRET_PREVIOUS are identical — nothing to do.');
    process.exit(1);
  }

  const newFp = crypto.createHash('sha256').update(NEW_SECRET).digest('hex').slice(0, 16);
  const oldFp = crypto.createHash('sha256').update(OLD_SECRET).digest('hex').slice(0, 16);

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     Bliss — Encryption Key Rotation Migration    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  if (DRY_RUN) {
    console.log('[DRY RUN] No changes will be written to the database.\n');
  }
  console.log(`New key fingerprint (SHA-256 prefix): ${newFp}...`);
  console.log(`Old key fingerprint (SHA-256 prefix): ${oldFp}...`);

  const prisma = new PrismaClient();

  try {
    const results = [];

    // ── User.email ────────────────────────────────────────────────────────────
    results.push(await migrateModel({
      label: 'User.email',
      idField: 'id',
      fields: [{ name: 'email', searchable: true }],
      fetchBatch: (cursor) => prisma.user.findMany({
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        select: { id: true, email: true },
        orderBy: { id: 'asc' },
      }),
      updateRecord: (id, data) => prisma.user.update({ where: { id }, data }),
    }));

    // ── Account.accountNumber ─────────────────────────────────────────────────
    results.push(await migrateModel({
      label: 'Account.accountNumber',
      idField: 'id',
      fields: [{ name: 'accountNumber', searchable: false }],
      fetchBatch: (cursor) => prisma.account.findMany({
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        select: { id: true, accountNumber: true },
        orderBy: { id: 'asc' },
      }),
      updateRecord: (id, data) => prisma.account.update({ where: { id }, data }),
    }));

    // ── Transaction.description + details ────────────────────────────────────
    results.push(await migrateModel({
      label: 'Transaction.description/details',
      idField: 'id',
      fields: [
        { name: 'description', searchable: false },
        { name: 'details',     searchable: false },
      ],
      fetchBatch: (cursor) => prisma.transaction.findMany({
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        select: { id: true, description: true, details: true },
        orderBy: { id: 'asc' },
      }),
      updateRecord: (id, data) => prisma.transaction.update({ where: { id }, data }),
    }));

    // ── PlaidItem.accessToken ─────────────────────────────────────────────────
    results.push(await migrateModel({
      label: 'PlaidItem.accessToken',
      idField: 'id',
      fields: [{ name: 'accessToken', searchable: false }],
      fetchBatch: (cursor) => prisma.plaidItem.findMany({
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        select: { id: true, accessToken: true },
        orderBy: { id: 'asc' },
      }),
      updateRecord: (id, data) => prisma.plaidItem.update({ where: { id }, data }),
    }));

    // ── Summary ───────────────────────────────────────────────────────────────
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

    if (DRY_RUN) {
      console.log('\n[DRY RUN] Re-run without --dry-run to apply these changes.');
      return;
    }

    if (totals.failed > 0) {
      console.error(`\nWARNING: ${totals.failed} field(s) could not be migrated.`);
      console.error('Investigate the errors above before removing ENCRYPTION_SECRET_PREVIOUS.');
      process.exit(1);
    }

    console.log('\n✓ Migration complete. Next steps:');
    console.log('  1. Verify that the application reads and writes data correctly');
    console.log('  2. Remove ENCRYPTION_SECRET_PREVIOUS from all environment configs');
    console.log('     (Vercel, Railway, or wherever your services are hosted)');
    console.log('  3. Restart both bliss-finance-api and bliss-backend-service');

  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\nMigration aborted:', err.message);
  process.exit(1);
});
