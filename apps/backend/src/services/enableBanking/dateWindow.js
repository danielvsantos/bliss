/**
 * Sync date window for bank feeds (#132, R8). Thin re-export of the shared
 * helpers so the API's displayed start date and the worker's `date_from`
 * can never drift apart. plaidSyncWorker uses `syncCutoffDate` for Plaid too.
 */

const { syncCutoffDate, syncDateFrom, isoDate, SYNC_OVERLAP_DAYS } = require('@bliss/shared/enablebanking');

module.exports = { syncCutoffDate, syncDateFrom, isoDate, SYNC_OVERLAP_DAYS };
