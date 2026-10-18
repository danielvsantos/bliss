/**
 * Per-tenant Enable Banking clients for the backend (#148). Each tenant brings
 * its own Enable Banking app (EnableBankingCredential); the client is resolved
 * per job from the database and cached per (tenant, credential, version), so
 * a replace or removal takes effect on the next job without a restart.
 *
 * `getTenantEnableBanking()` is null when the tenant has no credentials: its
 * connections are "paused" and skipped (never failed).
 */

const prisma = require('../../../prisma/prisma');
const { createTenantClientCache } = require('@bliss/shared/enablebanking');

const clientCache = createTenantClientCache({ max: 200 });
let testClient = null;

/**
 * @param {string} tenantId
 * @returns {Promise<{ client: object, credential: { id: string, tenantId: string, version: number, status: string } } | null>}
 *   `credential` carries metadata only — the private key never leaves here.
 */
async function getTenantEnableBanking(tenantId) {
    if (!tenantId) return null;
    const row = await prisma.enableBankingCredential.findUnique({ where: { tenantId } });
    if (!row) return null;
    return {
        client: testClient || clientCache.get(row),
        credential: { id: row.id, tenantId: row.tenantId, version: row.version, status: row.status },
    };
}

/**
 * Marks the tenant's credentials INVALID after Enable Banking rejected them
 * (#148, D5). Conditional on `version`, so a credential replaced moments ago
 * is never marked. Returns true when a row changed.
 */
async function markCredentialInvalid(tenantId, version) {
    const { count } = await prisma.enableBankingCredential.updateMany({
        where: { tenantId, version, status: { not: 'INVALID' } },
        data: { status: 'INVALID', invalidatedAt: new Date() },
    });
    return count > 0;
}

/** Tests only: every tenant with credentials gets this client (null restores the real one). */
function __setEnableBankingClientForTests(c) {
    testClient = c;
    clientCache.clear();
}

module.exports = { getTenantEnableBanking, markCredentialInvalid, __setEnableBankingClientForTests };
