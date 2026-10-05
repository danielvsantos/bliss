/**
 * Job → activity map for processing status (#100).
 *
 * `resolveActivity(queueName, job)` decides whether a BullMQ job is shown to
 * the tenant and how: its activity `type` (what the header chip groups by),
 * its `stage` (the label), `affects` (every activity type the job's chain will
 * still touch, which is what page banners match on) and whether it gets the
 * long stall clock. Jobs without `data.tenantId` (the nightly fan-outs) and
 * unknown job names return `null` and are never tracked.
 *
 * Pure: no Redis, no Prisma. See docs/specs/backend/23-activity-tracking.md.
 */

const { ACTIVITY_TYPES: T, STAGES: S } = require('@bliss/shared/activity');

const P = T.PORTFOLIO_UPDATE;
const A = T.ANALYTICS_UPDATE;

// Queue names, duplicated here (not required from queues/*) so this module
// stays free of the BullMQ / Redis imports the queue factories pull in.
const QUEUES = {
    EVENTS: 'events',
    PORTFOLIO: 'portfolio',
    ANALYTICS: 'analytics',
    PLAID_SYNC: 'plaid-sync',
    PLAID_PROCESSING: 'plaid-processing',
    SMART_IMPORT: 'smart-import',
    SECURITY_MASTER: 'security-master',
    SUBSCRIPTION_DETECTION: 'subscription-detection',
    INSIGHTS: 'insights',
};

const entry = (type, stage, affects, extra = {}) => ({ type, stage, affects, long: false, ephemeral: false, ...extra });

/** Events are short-lived scheduling hops: they bridge the gap between two jobs of a chain. */
const event = (type, affects) => entry(type, S.SCHEDULING, affects, { ephemeral: true });

const REBUILD_SCOPES = {
    'full-portfolio': [P, [P, A, T.SECURITY_DATA]],
    'full-analytics': [A, [A]],
    'scoped-analytics': [A, [A]],
    'single-asset': [P, [P]],
    'security-data': [T.SECURITY_DATA, [T.SECURITY_DATA, P]],
};

function resolveEvent(name, data) {
    switch (name) {
        case 'MANUAL_TRANSACTION_CREATED':
        case 'MANUAL_TRANSACTION_MODIFIED':
        case 'TRANSACTIONS_IMPORTED':
        case 'MANUAL_PORTFOLIO_PRICE_UPDATED':
        case 'PORTFOLIO_STALE_REVALUATION':
        case 'TENANT_CURRENCY_SETTINGS_UPDATED':
        case 'PORTFOLIO_CHANGES_PROCESSED':
        case 'PORTFOLIO_ITEMS_RECALCULATED':
            return event(P, [P, A]);
        case 'ANALYTICS_RECALCULATION_COMPLETE':
            // Chains into valuation unless it was an analytics-only rebuild.
            return data?._rebuildMeta?.rebuildType === 'full-analytics' ? event(A, [A]) : event(P, [P, A]);
        case 'CASH_HOLDINGS_PROCESSED':
            return event(A, [A, P]);
        case 'TAG_ASSIGNMENT_MODIFIED':
            return event(A, [A]);
        case 'PLAID_INITIAL_SYNC':
        case 'PLAID_SYNC_UPDATES':
        case 'PLAID_HISTORICAL_BACKFILL':
        case 'PLAID_TRANSACTION_RETRY':
            return event(T.BANK_SYNC, [T.BANK_SYNC, P, A]);
        case 'SMART_IMPORT_REQUESTED':
            return event(T.IMPORT, [T.IMPORT]);
        case 'SMART_IMPORT_COMMIT':
            return event(T.IMPORT, [T.IMPORT, P, A]);
        case 'SUBSCRIPTION_DETECTION_REQUESTED':
            return event(T.SUBSCRIPTION_SCAN, [T.SUBSCRIPTION_SCAN]);
        case 'MANUAL_REBUILD_REQUESTED': {
            const scope = REBUILD_SCOPES[data?.scope];
            return scope ? event(scope[0], scope[1]) : null;
        }
        default:
            return null;
    }
}

function resolvePortfolio(name, data) {
    switch (name) {
        case 'process-portfolio-changes': {
            // No transaction / deletion / account scope = a full rebuild.
            const full = !data?.transactionId && !data?.deletedTransaction && !(data?.accountIds?.length > 0);
            return entry(P, S.RECALCULATING_LOTS, [P, A], { long: full });
        }
        case 'process-cash-holdings':
            return entry(P, S.UPDATING_CASH, [P, A]);
        case 'value-all-assets':
        case 'generate-portfolio-valuation':
            return entry(P, S.VALUING_ASSETS, [P], { long: true });
        case 'value-portfolio-items':
        case 'recalculate-portfolio-items':
            return entry(P, S.VALUING_ASSETS, [P]);
        case 'process-simple-liability':
        case 'process-amortizing-loan':
            return entry(P, S.UPDATING_DEBTS, [P]);
        default:
            return null;
    }
}

function resolveAnalytics(name, data) {
    const full = name === 'full-rebuild-analytics'
        || (name === 'recalculate-analytics' && !data?.scope && !data?.scopes);
    // Analytics chains into valuation (ANALYTICS_RECALCULATION_COMPLETE) unless
    // it is an analytics-only manual rebuild or a scoped update with no items.
    const analyticsOnly = data?._rebuildMeta?.rebuildType === 'full-analytics'
        || data?._rebuildMeta?.rebuildType === 'scoped-analytics'
        || (!full && !(data?.portfolioItemIds?.length > 0));
    return entry(A, S.UPDATING_ANALYTICS, analyticsOnly ? [A] : [A, P], { long: full });
}

/**
 * @param {string} queueName
 * @param {{ name: string, data?: object }} job
 * @returns {{ type: string, stage: string, affects: string[], long: boolean, ephemeral: boolean } | null}
 */
function resolveActivity(queueName, job) {
    const name = job?.name;
    const data = job?.data;
    if (!name || !data || typeof data.tenantId !== 'string' || !data.tenantId) return null;

    switch (queueName) {
        case QUEUES.EVENTS:
            return resolveEvent(name, data);
        case QUEUES.PORTFOLIO:
            return resolvePortfolio(name, data);
        case QUEUES.ANALYTICS:
            return resolveAnalytics(name, data);
        case QUEUES.PLAID_SYNC:
            return entry(T.BANK_SYNC, S.FETCHING_BANK, [T.BANK_SYNC, P, A]);
        case QUEUES.PLAID_PROCESSING:
            return entry(T.BANK_SYNC, S.CLASSIFYING, [T.BANK_SYNC, P, A]);
        case QUEUES.SMART_IMPORT:
            if (name === 'commit-smart-import') return entry(T.IMPORT, S.COMMITTING, [T.IMPORT, P, A]);
            if (name === 'process-smart-import') return entry(T.IMPORT, S.PROCESSING_FILE, [T.IMPORT]);
            return null;
        case QUEUES.SECURITY_MASTER:
            if (name === 'refresh-tenant-securities' || name === 'refresh-single-symbol') {
                return entry(T.SECURITY_DATA, S.REFRESHING_MARKET_DATA, [T.SECURITY_DATA, P], { long: true });
            }
            return null;
        case QUEUES.SUBSCRIPTION_DETECTION:
            return name === 'detect-tenant' ? entry(T.SUBSCRIPTION_SCAN, S.SCANNING, [T.SUBSCRIPTION_SCAN]) : null;
        case QUEUES.INSIGHTS:
            return name === 'generate-tenant-insights' || name === 'generate-portfolio-intel'
                ? entry(T.INSIGHTS, S.GENERATING_INSIGHTS, [T.INSIGHTS], { long: true })
                : null;
        default:
            return null;
    }
}

module.exports = { resolveActivity, QUEUES };
