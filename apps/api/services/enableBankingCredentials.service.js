/**
 * Per-tenant Enable Banking credentials (#148) — the logic behind
 * /api/enablebanking/credentials. Tenant admins only (enforced by the routes).
 *
 * - The private key is write-only: it is parsed and normalised on save
 *   (`parsePrivateKey`), stored encrypted, and never selected by any read here.
 * - Saving runs a live GET /application probe (D6): invalid credentials are
 *   rejected and nothing is stored; an unreachable Enable Banking stores them
 *   as UNVERIFIED (R2).
 * - App changes are detected once, at save time (D3), against the stored
 *   credential or else the latest REMOVED history event. A confirmed change
 *   moves live connections to LOGIN_REQUIRED / APP_CHANGED in the same
 *   transaction; a first-ever Set resumes existing connections (R8).
 * - Remove deletes the credential; connections become "paused" (derived on
 *   read, D4) with no write to them.
 *
 * See docs/specs/api/27-enable-banking-api.md.
 */

import { StatusCodes } from 'http-status-codes';
import prisma from '../prisma/prisma.js';
import {
  KeyFormatError,
  MAX_PRIVATE_KEY_BYTES,
  appIdHash,
  createClient,
  getBaseUrl,
  isValidAppId,
  parsePrivateKey,
  probeApplication,
} from '@bliss/shared/enablebanking';
import { PROVIDER, getCallbackUrl } from '../utils/enableBanking.js';

/** Enable Banking's restricted-mode limit per application. */
export const ACCOUNT_LIMIT = 5;
export const HISTORY_LIMIT = 10;
const PROBE_TIMEOUT_MS = 10_000;
/** Connection statuses that sync, and therefore stop on an app change. */
const LIVE_STATUSES = ['ACTIVE', 'ERROR'];

/** Every field a response may carry. `privateKey` is deliberately absent. */
const CREDENTIAL_PUBLIC_SELECT = {
  id: true,
  appId: true,
  appIdHash: true,
  keyFingerprint: true,
  keyBits: true,
  status: true,
  lastValidatedAt: true,
  invalidatedAt: true,
  callbackRegistered: true,
  version: true,
  updatedAt: true,
};

export class CredentialError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}

/**
 * Validates a PUT body. The key is parsed here (server authority, R1a/R2).
 * @returns {{ appId: string, key: { pem: string, bits: number, fingerprint: string }, confirmAppChange: boolean }}
 */
export function validateCredentialBody(body) {
  const appId = typeof body?.appId === 'string' ? body.appId.trim() : '';
  if (!isValidAppId(appId)) {
    throw new CredentialError(StatusCodes.BAD_REQUEST, { error: 'The application id must be a UUID', code: 'INVALID_APP_ID' });
  }
  const raw = body?.privateKey;
  if (typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') > MAX_PRIVATE_KEY_BYTES) {
    throw new CredentialError(StatusCodes.BAD_REQUEST, { error: 'The private key is larger than 16 KB', code: 'KEY_TOO_LARGE' });
  }
  let key;
  try {
    key = parsePrivateKey(raw);
  } catch (err) {
    if (err instanceof KeyFormatError) {
      throw new CredentialError(StatusCodes.BAD_REQUEST, { error: err.message, code: err.code });
    }
    throw err;
  }
  return { appId, key, confirmAppChange: body?.confirmAppChange === true };
}

/** GET /application with the supplied credentials (10 s timeout, never cached). */
export function probeCredentials({ appId, privateKey }) {
  const client = createClient({ appId, privateKey, baseUrl: getBaseUrl(), timeoutMs: PROBE_TIMEOUT_MS });
  return probeApplication(client, { callbackUrl: getCallbackUrl() });
}

function countConnections(tenantId, statuses) {
  return prisma.plaidItem.count({
    where: {
      tenantId,
      provider: PROVIDER,
      status: Array.isArray(statuses) ? { in: statuses } : statuses,
    },
  });
}

/** Connections that would stop syncing on Remove (everything not disconnected). */
const countNonRevoked = (tenantId) => countConnections(tenantId, { not: 'REVOKED' });

/** D3: the app the tenant's existing connections belong to, as a hash (null = none known). */
async function previousAppIdHash(tenantId, stored) {
  if (stored) return stored.appIdHash;
  const removed = await prisma.enableBankingCredentialEvent.findFirst({
    where: { tenantId, action: 'REMOVED' },
    orderBy: { createdAt: 'desc' },
    select: { appIdHash: true },
  });
  return removed?.appIdHash ?? null;
}

function serializeCredential(row) {
  if (!row) return null;
  return {
    appId: row.appId,
    keyFingerprint: row.keyFingerprint,
    keyBits: row.keyBits,
    status: row.status,
    lastValidatedAt: row.lastValidatedAt,
    callbackRegistered: row.callbackRegistered,
    updatedAt: row.updatedAt,
  };
}

/** The GET /api/enablebanking/credentials payload. Never contains the key. */
export async function loadCredentialsView(tenantId) {
  // Top-level reads: the encryption extension decrypts `appId` only on the queried model.
  const [credential, history, activeConnections, nonRevoked, linkedAccounts] = await Promise.all([
    prisma.enableBankingCredential.findUnique({ where: { tenantId }, select: CREDENTIAL_PUBLIC_SELECT }),
    prisma.enableBankingCredentialEvent.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      select: {
        action: true,
        appId: true,
        keyFingerprint: true,
        createdAt: true,
        user: { select: { id: true, name: true } },
      },
    }),
    countConnections(tenantId, 'ACTIVE'),
    countNonRevoked(tenantId),
    prisma.enableBankingAccount.count({
      where: { tenantId, accountId: { not: null }, plaidItem: { status: { not: 'REVOKED' } } },
    }),
  ]);

  return {
    configured: Boolean(credential),
    callbackUrl: getCallbackUrl(),
    credential: serializeCredential(credential),
    usage: {
      activeConnections,
      pausedConnections: credential ? 0 : nonRevoked,
      linkedAccounts,
      limit: ACCOUNT_LIMIT,
    },
    history: history.map((h) => ({
      action: h.action,
      appId: h.appId,
      keyFingerprint: h.keyFingerprint,
      user: h.user ? { id: h.user.id, name: h.user.name } : null,
      createdAt: h.createdAt,
    })),
  };
}

/**
 * PUT: set, replace or rotate (#148, R1/R2/R4).
 * @returns {Promise<{ created: boolean }>}
 * @throws {CredentialError}
 */
export async function saveCredentials({ tenantId, userId, body }) {
  const { appId, key, confirmAppChange } = validateCredentialBody(body);
  const newHash = appIdHash(appId);

  const stored = await prisma.enableBankingCredential.findUnique({
    where: { tenantId },
    select: { id: true, appIdHash: true, keyFingerprint: true },
  });
  const previousHash = await previousAppIdHash(tenantId, stored);
  const appChanged = previousHash !== null && previousHash !== newHash;

  if (appChanged && !confirmAppChange) {
    const affectedConnections = await countConnections(tenantId, LIVE_STATUSES);
    if (affectedConnections > 0) {
      throw new CredentialError(StatusCodes.CONFLICT, {
        error: 'Changing the application stops the connections that use it until they are reconnected.',
        code: 'CONFIRMATION_REQUIRED',
        affectedConnections,
      });
    }
  }

  const probe = await probeCredentials({ appId, privateKey: key.pem });
  if (probe.result === 'INVALID') {
    throw new CredentialError(StatusCodes.UNPROCESSABLE_ENTITY, {
      error: 'Enable Banking rejected these credentials. Check that the private key belongs to this application.',
      code: 'INVALID_CREDENTIALS',
    });
  }
  if (probe.result === 'SANDBOX') {
    throw new CredentialError(StatusCodes.UNPROCESSABLE_ENTITY, {
      error: 'This is a sandbox application. Create a production application in restricted mode.',
      code: 'SANDBOX_APP',
    });
  }

  const now = new Date();
  const verified = probe.result === 'VERIFIED';
  const fields = {
    appId,
    appIdHash: newHash,
    privateKey: key.pem,
    keyFingerprint: key.fingerprint,
    keyBits: key.bits,
    status: verified ? 'VERIFIED' : 'UNVERIFIED',
    lastValidatedAt: verified ? now : null,
    invalidatedAt: null,
    callbackRegistered: probe.callbackRegistered,
    updatedByUserId: userId,
  };

  let action = null;
  if (!stored) action = 'SET';
  else if (stored.appIdHash !== newHash) action = 'REPLACED';
  else if (stored.keyFingerprint !== key.fingerprint) action = 'KEY_ROTATED';
  // Same app and same key: a re-save, recorded like a re-verify (no history entry).

  await prisma.$transaction(async (tx) => {
    await tx.enableBankingCredential.upsert({
      where: { tenantId },
      create: { tenantId, ...fields },
      update: { ...fields, version: { increment: 1 } },
    });
    if (action) {
      await tx.enableBankingCredentialEvent.create({
        data: { tenantId, action, appId, appIdHash: newHash, keyFingerprint: key.fingerprint, userId },
      });
    }
    if (appChanged) {
      await tx.plaidItem.updateMany({
        where: { tenantId, provider: PROVIDER, status: { in: LIVE_STATUSES } },
        data: { status: 'LOGIN_REQUIRED', errorCode: 'APP_CHANGED' },
      });
    }
  });

  return { created: !stored };
}

/**
 * DELETE: remove the credentials; connections become paused, data is kept (R4).
 * @throws {CredentialError}
 */
export async function removeCredentials({ tenantId, userId, confirm }) {
  const stored = await prisma.enableBankingCredential.findUnique({
    where: { tenantId },
    select: { id: true, appId: true, appIdHash: true, keyFingerprint: true },
  });
  if (!stored) {
    throw new CredentialError(StatusCodes.NOT_FOUND, { error: 'Enable Banking is not set up for this workspace', code: 'NOT_CONFIGURED' });
  }
  if (!confirm) {
    const affectedConnections = await countNonRevoked(tenantId);
    if (affectedConnections > 0) {
      throw new CredentialError(StatusCodes.CONFLICT, {
        error: 'Removing the credentials pauses every connection until credentials are added again.',
        code: 'CONFIRMATION_REQUIRED',
        affectedConnections,
      });
    }
  }
  await prisma.$transaction(async (tx) => {
    await tx.enableBankingCredential.delete({ where: { id: stored.id } });
    await tx.enableBankingCredentialEvent.create({
      data: {
        tenantId,
        action: 'REMOVED',
        appId: stored.appId,
        appIdHash: stored.appIdHash,
        keyFingerprint: stored.keyFingerprint,
        userId,
      },
    });
  });
}

/**
 * POST verify: re-runs the probe with the stored credentials. No history entry.
 * @throws {CredentialError}
 */
export async function reverifyCredentials(tenantId) {
  const row = await prisma.enableBankingCredential.findUnique({
    where: { tenantId },
    select: { id: true, appId: true, privateKey: true, status: true, invalidatedAt: true, version: true },
  });
  if (!row) {
    throw new CredentialError(StatusCodes.NOT_FOUND, { error: 'Enable Banking is not set up for this workspace', code: 'NOT_CONFIGURED' });
  }
  const probe = await probeCredentials({ appId: row.appId, privateKey: row.privateKey });
  const now = new Date();
  let data;
  if (probe.result === 'VERIFIED') {
    data = { status: 'VERIFIED', lastValidatedAt: now, invalidatedAt: null, callbackRegistered: probe.callbackRegistered };
  } else if (probe.result === 'UNREACHABLE') {
    data = { status: 'UNVERIFIED' };
  } else {
    data = { status: 'INVALID', invalidatedAt: row.status === 'INVALID' && row.invalidatedAt ? row.invalidatedAt : now };
  }
  // Conditional on version: a replace that landed meanwhile is never overwritten.
  await prisma.enableBankingCredential.updateMany({ where: { id: row.id, version: row.version }, data });
}
