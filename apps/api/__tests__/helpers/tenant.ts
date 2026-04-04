/**
 * Integration test helpers — tenant lifecycle management.
 *
 * Creates an isolated Tenant + User in the bliss_test database for use in
 * integration tests. Returns a pre-signed JWT token so callers can immediately
 * make authenticated requests without going through the signup flow.
 *
 * teardownTenant() performs an ordered delete that handles the User→Tenant
 * relation (which has no onDelete: Cascade in the schema) before deleting
 * the Tenant itself (which cascades to Category, Account, Transaction, etc.).
 */

import prisma from '../../prisma/prisma.js';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET_CURRENT || 'test-jwt-secret';

export interface IsolatedTenant {
  tenantId: string;
  userId: string;
  token: string;
}

/**
 * Creates a Tenant + admin User directly via Prisma (bypasses signup handler).
 *
 * @param suffix - Optional label appended to names for readability in DB inspection.
 */
export async function createIsolatedTenant(suffix = ''): Promise<IsolatedTenant> {
  const label = suffix ? `-${suffix}` : '';
  const timestamp = Date.now();

  const tenant = await prisma.tenant.create({
    data: { name: `test-tenant${label}-${timestamp}` },
  });

  // Email is encrypted by the Prisma middleware automatically
  const user = await prisma.user.create({
    data: {
      email: `admin${label}-${timestamp}@test.bliss`,
      tenantId: tenant.id,
      role: 'admin',
    },
  });

  // Mint a short-lived JWT token signed with the test secret
  const token = jwt.sign(
    { jti: uuidv4(), userId: user.id, tenantId: tenant.id },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  return { tenantId: tenant.id, userId: user.id, token };
}

/**
 * Deletes the Tenant and all linked data.
 *
 * Handles the non-cascading relation (User) before deleting the
 * Tenant itself, which cascades to Category, Account, Transaction, etc.
 */
export async function teardownTenant(tenantId: string): Promise<void> {
  // User has no onDelete: Cascade on its Tenant relation
  await prisma.user.deleteMany({ where: { tenantId } });
  // Tenant delete cascades to Category, Account, StagedImport, TransactionEmbedding, etc.
  await prisma.tenant.delete({ where: { id: tenantId } });
}
