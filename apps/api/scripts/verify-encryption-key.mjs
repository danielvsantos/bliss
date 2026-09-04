#!/usr/bin/env node
/**
 * Encryption Key Rotation — Verification Gate
 *
 * Scans every field in the rotation coverage manifest and confirms it
 * decrypts under ENCRYPTION_SECRET *alone*, plus a plaintext sanity check
 * per field (e.g. an email contains "@", rawJson is JSON-parseable).
 *
 * This script intentionally NEVER reads ENCRYPTION_SECRET_PREVIOUS — if it
 * did, a row still encrypted under the old key would silently pass, which
 * defeats the entire point of the gate.
 *
 * Exit code 0 only when undecryptable === 0 AND insane === 0 across every
 * model/field. The operator must see this before removing
 * ENCRYPTION_SECRET_PREVIOUS. Full procedure: docs/guides/key-rotation.md §2.
 *
 * Usage:
 *   ENCRYPTION_SECRET=<new> node scripts/verify-encryption-key.mjs
 */

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { encryptedFields } from '@bliss/shared/encryption';
import { ROTATION_COVERAGE, assertCoverageComplete } from './lib/encryptionRotationCoverage.mjs';

const BATCH_SIZE = 200;

const ALGORITHM       = 'aes-256-gcm';
const IV_LENGTH       = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH     = 16;
const MIN_ENC_LENGTH  = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;

function deriveKey(salt, secret) {
  return crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha256');
}

export function keyFingerprint(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/** Throws on auth-tag failure — never falls back to another key. */
export function tryDecryptStrict(encryptedText, secret) {
  const buffer = Buffer.from(encryptedText, 'base64');
  if (buffer.length < MIN_ENC_LENGTH) {
    throw new Error('value is too short to be AES-256-GCM ciphertext');
  }

  const salt      = buffer.subarray(0, SALT_LENGTH);
  const iv        = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag   = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(salt, secret);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Verifies one batch-fetching model/field set against `secret`.
 * @param {object} opts
 * @param {string}   opts.label
 * @param {Function} opts.fetchBatch - (cursor) => Promise<record[]>
 * @param {string}   opts.idField
 * @param {Array}    opts.fields     - [{ name, sanity }]
 * @param {string}   opts.secret
 */
export async function verifyModel({ label, fetchBatch, idField, fields, secret }) {
  let cursor = undefined;
  let scanned = 0;
  let ok = 0;
  let undecryptable = 0;
  let insane = 0;
  const problems = [];

  process.stdout.write(`\nVerifying ${label}...\n`);

  while (true) {
    const records = await fetchBatch(cursor);
    if (records.length === 0) break;
    cursor = records[records.length - 1][idField];

    for (const record of records) {
      for (const field of fields) {
        const value = record[field.name];
        if (!value) continue;
        scanned++;

        let plaintext;
        try {
          plaintext = tryDecryptStrict(value, secret);
        } catch (err) {
          undecryptable++;
          problems.push(`${label}#${record[idField]}.${field.name}: undecryptable (${err.message})`);
          continue;
        }

        if (field.sanity && !field.sanity(plaintext)) {
          insane++;
          problems.push(`${label}#${record[idField]}.${field.name}: decrypted but failed sanity check`);
          continue;
        }

        ok++;
      }
    }

    if (records.length < BATCH_SIZE) break;
  }

  console.log(`  Done: ${scanned} scanned | ${ok} ok | ${undecryptable} undecryptable | ${insane} insane`);
  return { label, scanned, ok, undecryptable, insane, problems };
}

function buildJobFromCoverageEntry(entry, prisma, secret) {
  const select = { [entry.idField]: true };
  for (const field of entry.fields) select[field.name] = true;

  return {
    label: entry.label,
    idField: entry.idField,
    fields: entry.fields,
    secret,
    fetchBatch: (cursor) => prisma[entry.prismaModel].findMany({
      take: BATCH_SIZE,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { [entry.idField]: cursor } : undefined,
      select,
      orderBy: entry.orderBy,
    }),
  };
}

export async function run({ prisma, secret }) {
  assertCoverageComplete(encryptedFields);

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Bliss — Encryption Key Rotation Verification   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Active key fingerprint (SHA-256 prefix): ${keyFingerprint(secret)}...`);
  console.log('(ENCRYPTION_SECRET_PREVIOUS is never read by this script.)');

  const results = [];
  for (const entry of ROTATION_COVERAGE) {
    results.push(await verifyModel(buildJobFromCoverageEntry(entry, prisma, secret)));
  }

  const totals = results.reduce(
    (acc, r) => ({
      scanned:       acc.scanned       + r.scanned,
      ok:            acc.ok            + r.ok,
      undecryptable: acc.undecryptable + r.undecryptable,
      insane:        acc.insane        + r.insane,
    }),
    { scanned: 0, ok: 0, undecryptable: 0, insane: 0 }
  );

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║               Verification Summary               ║');
  console.log('╚══════════════════════════════════════════════════╝');
  for (const r of results) {
    console.log(`  ${r.label.padEnd(38)} scanned=${r.scanned} ok=${r.ok} undecryptable=${r.undecryptable} insane=${r.insane}`);
  }
  console.log(`  ${'TOTAL'.padEnd(38)} scanned=${totals.scanned} ok=${totals.ok} undecryptable=${totals.undecryptable} insane=${totals.insane}`);

  const allProblems = results.flatMap((r) => r.problems);
  if (allProblems.length > 0) {
    console.error('\nProblems found:');
    for (const p of allProblems) console.error(`  - ${p}`);
  }

  if (totals.undecryptable === 0 && totals.insane === 0) {
    console.log('\n✓ VERIFIED — 0 undecryptable rows, 0 sanity failures. Safe to remove ENCRYPTION_SECRET_PREVIOUS.');
  } else {
    console.error('\n✗ NOT SAFE — do not remove ENCRYPTION_SECRET_PREVIOUS. Re-run rotate-encryption-key.mjs and investigate.');
  }

  return totals;
}

async function main() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    console.error('ERROR: ENCRYPTION_SECRET is required');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const totals = await run({ prisma, secret });
    process.exit(totals.undecryptable === 0 && totals.insane === 0 ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error('\nVerification aborted:', err.message);
    process.exit(1);
  });
}
