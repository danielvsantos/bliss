/**
 * Integration test helpers — tenant lifecycle management.
 *
 * Creates an isolated Tenant (and optionally a User) in the bliss_test database
 * for use in integration tests. Teardown handles non-cascading relations before
 * deleting the Tenant (which cascades to Category, Account, Transaction, etc.).
 */

const prisma = require('../../../prisma/prisma');

/**
 * Creates an isolated Tenant record in bliss_test.
 *
 * @param {Object} [opts]
 * @param {string} [opts.suffix] - Optional suffix added to the tenant name (e.g. 'feedback', 'events')
 * @returns {Promise<{ tenantId: string }>}
 */
async function createIsolatedTenant({ suffix = '' } = {}) {
  const label = suffix ? `-${suffix}` : '';
  const tenant = await prisma.tenant.create({
    data: { name: `test-tenant${label}-${Date.now()}` },
  });

  return { tenantId: tenant.id };
}

/**
 * Deletes a Tenant and all linked data.
 *
 * Handles non-cascading relation (User) before deleting the Tenant,
 * which cascades to Category, Account, StagedImport, TransactionEmbedding, etc.
 *
 * @param {string} tenantId
 */
async function teardownTenant(tenantId) {
  // User has no onDelete: Cascade on its Tenant relation
  await prisma.user.deleteMany({ where: { tenantId } });
  // Tenant delete cascades to Category, Account, Transaction, etc.
  await prisma.tenant.delete({ where: { id: tenantId } });
}

module.exports = { createIsolatedTenant, teardownTenant };
