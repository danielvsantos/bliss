/**
 * Enable Banking test helpers (#148): the shared test keys and a direct
 * credential insert for suites that need a tenant with Enable Banking set up
 * without going through the PUT route (and its live probe).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appIdHash, parsePrivateKey } from '@bliss/shared/enablebanking';
import prisma from '../../prisma/prisma.js';

export const KEYS_DIR = join(__dirname, '../../../../packages/shared/test-fixtures/enablebanking-keys');
export const readTestKey = (name: string) => readFileSync(join(KEYS_DIR, name), 'utf8');
export const TEST_KEY_MANIFEST: Record<string, { ok: boolean; bits?: number; key?: string; code?: string }> =
  JSON.parse(readTestKey('manifest.json'));

export const TEST_APP_ID = '6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

export async function saveTestCredential(tenantId: string, { appId = TEST_APP_ID, keyFile = 'rsa2048-pkcs8.pem', status = 'VERIFIED' } = {}) {
  const key = parsePrivateKey(readTestKey(keyFile));
  return prisma.enableBankingCredential.create({
    data: {
      tenantId,
      appId,
      appIdHash: appIdHash(appId),
      privateKey: key.pem,
      keyFingerprint: key.fingerprint,
      keyBits: key.bits,
      status,
    },
  });
}

export const removeTestCredential = (tenantId: string) =>
  prisma.enableBankingCredential.deleteMany({ where: { tenantId } });
