import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    apiKey: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import {
  LAST_USED_THROTTLE_MS,
  _resetLastUsedThrottle,
  expiryFromDays,
  generateApiKey,
  hashApiKey,
  keyStatus,
  parseApiKey,
  randomBase62,
  requestIp,
  touchLastUsed,
  verifyApiKey,
} from '../../../utils/apiKeys.js';

const TOKEN_RE = /^bliss_[A-Za-z0-9]{8}_[A-Za-z0-9]{43}$/;

function keyRow(token: string, overrides: Record<string, unknown> = {}) {
  const { prefix } = parseApiKey(token)!;
  return {
    id: 'key-1',
    tenantId: 'tenant-1',
    integrationId: 'int-1',
    prefix,
    keyHash: hashApiKey(token),
    expiresAt: null,
    revokedAt: null,
    integration: {
      id: 'int-1',
      tenantId: 'tenant-1',
      accessLevel: 'READ_ONLY',
      createdByUserId: 'user-1',
      revokedAt: null,
    },
    ...overrides,
  };
}

const CREATOR = { id: 'user-1', tenantId: 'tenant-1', email: 'admin@test.bliss', role: 'admin' };

beforeEach(() => {
  vi.clearAllMocks();
  _resetLastUsedThrottle();
  mockPrisma.apiKey.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.user.findUnique.mockResolvedValue(CREATOR);
});

describe('generateApiKey', () => {
  it('produces a bliss_<prefix>_<secret> token with its prefix and SHA-256 hash', () => {
    const { token, prefix, keyHash } = generateApiKey();
    expect(token).toMatch(TOKEN_RE);
    expect(prefix).toBe(token.slice(6, 14));
    expect(keyHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateApiKey().token));
    expect(tokens.size).toBe(200);
  });

  it('has ≥256 bits of secret entropy (43 base62 chars)', () => {
    expect(43 * Math.log2(62)).toBeGreaterThanOrEqual(256);
    expect(randomBase62(43)).toMatch(/^[A-Za-z0-9]{43}$/);
  });
});

describe('hashApiKey', () => {
  it('is deterministic', () => {
    expect(hashApiKey('bliss_a')).toBe(hashApiKey('bliss_a'));
    expect(hashApiKey('bliss_a')).not.toBe(hashApiKey('bliss_b'));
  });
});

describe('parseApiKey', () => {
  it('accepts a well-formed token', () => {
    const { token, prefix } = generateApiKey();
    expect(parseApiKey(token)).toEqual({ prefix });
  });

  it.each([
    undefined,
    '',
    'bliss_',
    'bliss_short_secret',
    'bliss_ABCDEFGH_tooShort',
    `bliss_ABCDEFG_${'a'.repeat(43)}`,
    `bliss_ABCDEFGH_${'a'.repeat(44)}`,
    `bliss_ABCD-FGH_${'a'.repeat(43)}`,
    `BLISS_ABCDEFGH_${'a'.repeat(43)}`,
    `bliss_ABCDEFGH_${'a'.repeat(43)} `,
  ])('rejects %s', (value) => {
    expect(parseApiKey(value as any)).toBeNull();
  });
});

describe('expiryFromDays / keyStatus', () => {
  const now = new Date('2026-10-01T00:00:00Z');

  it('computes the expiry date, or null for no expiry', () => {
    expect(expiryFromDays(90, now)!.toISOString()).toBe('2026-12-30T00:00:00.000Z');
    expect(expiryFromDays(null, now)).toBeNull();
  });

  it('derives status with revocation winning over expiry', () => {
    expect(keyStatus({ revokedAt: null, expiresAt: null }, now)).toBe('active');
    expect(keyStatus({ revokedAt: null, expiresAt: new Date('2026-09-30') }, now)).toBe('expired');
    expect(keyStatus({ revokedAt: new Date(), expiresAt: new Date('2026-09-30') }, now)).toBe('revoked');
  });
});

describe('verifyApiKey', () => {
  it('rejects malformed tokens without touching the DB', async () => {
    await expect(verifyApiKey('bliss_nope')).resolves.toEqual({ ok: false, code: 'TOKEN_INVALID' });
    expect(mockPrisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('returns TOKEN_INVALID for an unknown prefix (e.g. a cascade-deleted key)', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null);
    await expect(verifyApiKey(generateApiKey().token)).resolves.toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('returns TOKEN_INVALID when the secret does not match the stored hash', async () => {
    const { token } = generateApiKey();
    const row = keyRow(token);
    mockPrisma.apiKey.findUnique.mockResolvedValue(row);
    const forged = `${token.slice(0, 15)}${'x'.repeat(43)}`;
    await expect(verifyApiKey(forged)).resolves.toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('looks up by prefix and resolves key, integration and creating user', async () => {
    const { token } = generateApiKey();
    mockPrisma.apiKey.findUnique.mockResolvedValue(keyRow(token));

    const result = await verifyApiKey(token);

    expect(mockPrisma.apiKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { prefix: token.slice(6, 14) } }),
    );
    expect(result).toMatchObject({ ok: true, user: CREATOR, integration: { id: 'int-1' }, apiKey: { id: 'key-1' } });
  });

  it('returns TOKEN_REVOKED when the key is revoked', async () => {
    const { token } = generateApiKey();
    mockPrisma.apiKey.findUnique.mockResolvedValue(keyRow(token, { revokedAt: new Date() }));
    await expect(verifyApiKey(token)).resolves.toEqual({ ok: false, code: 'TOKEN_REVOKED' });
  });

  it('returns TOKEN_REVOKED when the integration is revoked', async () => {
    const { token } = generateApiKey();
    const row = keyRow(token);
    row.integration.revokedAt = new Date() as any;
    mockPrisma.apiKey.findUnique.mockResolvedValue(row);
    await expect(verifyApiKey(token)).resolves.toEqual({ ok: false, code: 'TOKEN_REVOKED' });
  });

  it('returns TOKEN_EXPIRED once expiresAt has passed', async () => {
    const { token } = generateApiKey();
    mockPrisma.apiKey.findUnique.mockResolvedValue(keyRow(token, { expiresAt: new Date(Date.now() - 1000) }));
    await expect(verifyApiKey(token)).resolves.toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
  });

  it('returns TOKEN_INVALID when the integration or creator belongs to another tenant', async () => {
    const { token } = generateApiKey();
    const row = keyRow(token);
    row.integration.tenantId = 'tenant-2';
    mockPrisma.apiKey.findUnique.mockResolvedValue(row);
    await expect(verifyApiKey(token)).resolves.toEqual({ ok: false, code: 'TOKEN_INVALID' });

    mockPrisma.apiKey.findUnique.mockResolvedValue(keyRow(token));
    mockPrisma.user.findUnique.mockResolvedValue({ ...CREATOR, tenantId: 'tenant-2' });
    await expect(verifyApiKey(token)).resolves.toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('returns TOKEN_INVALID when the creating user no longer exists', async () => {
    const { token } = generateApiKey();
    mockPrisma.apiKey.findUnique.mockResolvedValue(keyRow(token));
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(verifyApiKey(token)).resolves.toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });
});

describe('touchLastUsed', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('writes at most once per key per minute', async () => {
    const t0 = new Date('2026-10-01T00:00:00Z');
    touchLastUsed({ id: 'k1' }, '1.2.3.4', t0);
    touchLastUsed({ id: 'k1' }, '1.2.3.4', new Date(t0.getTime() + 10_000));
    await flush();
    expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'k1',
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(t0.getTime() - LAST_USED_THROTTLE_MS) } }],
      },
      data: { lastUsedAt: t0, lastUsedIp: '1.2.3.4' },
    });

    touchLastUsed({ id: 'k1' }, '1.2.3.4', new Date(t0.getTime() + LAST_USED_THROTTLE_MS));
    touchLastUsed({ id: 'k2' }, null, t0);
    await flush();
    expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledTimes(3);
  });

  it('swallows DB errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPrisma.apiKey.updateMany.mockRejectedValue(new Error('db down'));
    expect(() => touchLastUsed({ id: 'k3' }, null)).not.toThrow();
    await flush();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('requestIp', () => {
  it('prefers x-real-ip, then x-forwarded-for, then the socket', () => {
    expect(requestIp({ headers: { 'x-real-ip': '1.1.1.1' } })).toBe('1.1.1.1');
    expect(requestIp({ headers: { 'x-forwarded-for': '2.2.2.2, 3.3.3.3' } })).toBe('2.2.2.2');
    expect(requestIp({ headers: {}, socket: { remoteAddress: '4.4.4.4' } })).toBe('4.4.4.4');
    expect(requestIp({ headers: {} })).toBeNull();
  });
});
