/**
 * Unattended-access budget enforcement (#132, R12 / decision D5).
 *
 * `consumeAccess` INCRs the per-account, per-Madrid-day counter before an
 * account's data calls and reports whether the call is within budget. Redis
 * failures fail OPEN (the bank's own 429 remains the backstop) so a Redis blip
 * never silently stops ingestion.
 */

const { budgetKey, budgetDay, getDailyBudget, BUDGET_KEY_TTL_SECONDS } = require('@bliss/shared/enablebanking');
const logger = require('../../utils/logger');

async function consumeAccess(redis, ebAccountId, now = new Date()) {
    const limit = getDailyBudget();
    const key = budgetKey(ebAccountId, budgetDay(now));
    try {
        const used = await redis.incr(key);
        if (used === 1) await redis.expire(key, BUDGET_KEY_TTL_SECONDS);
        return { allowed: used <= limit, used, limit };
    } catch (err) {
        logger.warn(`[enableBanking] budget check failed for ${ebAccountId}, allowing: ${err.message}`);
        return { allowed: true, used: null, limit };
    }
}

module.exports = { consumeAccess };
