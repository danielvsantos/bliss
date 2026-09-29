/**
 * Integration test helpers — integration tokens (#84).
 *
 * createIntegrationKey() inserts an Integration + ApiKey directly via Prisma
 * (bypassing the management endpoints) and returns the plaintext token, so a
 * suite can call handlers with `Authorization: Bearer <token>`.
 *
 * No teardown is needed: teardownTenant() deletes the tenant's users first,
 * which cascades to their integrations and keys.
 */

import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../../prisma/prisma.js';
import { generateApiKey } from '../../utils/apiKeys.js';

const JWT_SECRET = process.env.JWT_SECRET_CURRENT || 'test-jwt-secret';

export interface IntegrationKey {
  token: string;
  integrationId: string;
  apiKeyId: string;
  prefix: string;
}

export async function createIntegrationKey(
  tenant: { tenantId: string; userId: string },
  {
    accessLevel = 'READ_ONLY',
    expiresAt = null,
    revoked = false,
    integrationId,
    name = 'Test integration',
  }: {
    accessLevel?: 'READ_ONLY' | 'READ_WRITE';
    expiresAt?: Date | null;
    revoked?: boolean;
    integrationId?: string;
    name?: string;
  } = {},
): Promise<IntegrationKey> {
  const id = integrationId ?? (await prisma.integration.create({
    data: { tenantId: tenant.tenantId, name, accessLevel, createdByUserId: tenant.userId },
  })).id;

  const { token, prefix, keyHash } = generateApiKey();
  const key = await prisma.apiKey.create({
    data: {
      tenantId: tenant.tenantId,
      integrationId: id,
      name: 'Test key',
      prefix,
      keyHash,
      expiresAt,
      revokedAt: revoked ? new Date() : null,
    },
  });

  return { token, integrationId: id, apiKeyId: key.id, prefix };
}

/** Adds a user with the given role to an existing tenant and signs a JWT for it. */
export async function createTenantUser(tenantId: string, role: 'admin' | 'member' | 'viewer') {
  const user = await prisma.user.create({
    data: {
      email: `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.bliss`,
      tenantId,
      role,
    },
  });
  const token = jwt.sign({ jti: uuidv4(), userId: user.id, tenantId }, JWT_SECRET, { expiresIn: '1h' });
  return { userId: user.id, token };
}

export function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}
