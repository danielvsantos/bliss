const prisma = require('../../prisma/prisma.js');
const logger = require('../utils/logger');

/**
 * Clean up expired insights based on their expiresAt timestamp.
 * Runs as part of the daily insight cron or as a standalone job.
 *
 * Returns the count of deleted insights.
 */
async function cleanupExpiredInsights() {
  const now = new Date();

  const result = await prisma.insight.deleteMany({
    where: {
      expiresAt: {
        not: null,
        lt: now,
      },
    },
  });

  if (result.count > 0) {
    logger.info('Expired insights cleaned up:', { deletedCount: result.count });
  }

  return result.count;
}

/**
 * Get retention statistics for a tenant.
 * Useful for debugging and monitoring.
 */
async function getRetentionStats(tenantId) {
  const stats = await prisma.insight.groupBy({
    by: ['tier'],
    where: { tenantId },
    _count: { id: true },
    _min: { createdAt: true },
    _max: { createdAt: true },
  });

  const expired = await prisma.insight.count({
    where: {
      tenantId,
      expiresAt: { not: null, lt: new Date() },
    },
  });

  return {
    byTier: stats.map((s) => ({
      tier: s.tier,
      count: s._count.id,
      oldest: s._min.createdAt,
      newest: s._max.createdAt,
    })),
    expiredCount: expired,
  };
}

module.exports = {
  cleanupExpiredInsights,
  getRetentionStats,
};
