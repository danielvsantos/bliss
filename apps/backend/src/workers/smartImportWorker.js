const Sentry = require('@sentry/node');
const { Worker } = require('bullmq');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { createStorageAdapter } = require('@bliss/shared/storage');
const prisma = require('../../prisma/prisma');
const logger = require('../utils/logger');
const { getRedisConnection } = require('../utils/redis');
const { SMART_IMPORT_QUEUE_NAME } = require('../queues/smartImportQueue');
const { reportWorkerFailure } = require('../utils/workerFailureReporter');
const { parseFile } = require('../services/adapterEngine');
const twelveDataService = require('../services/twelveDataService');
const cryptoService = require('../services/cryptoService');
const securityMasterService = require('../services/securityMasterService');
const categorizationService = require('../services/categorizationService');
const { warmDescriptionCache } = require('../utils/descriptionCache');
const { getCategoriesForTenant } = require('../utils/categoryCache');
const { computeTransactionHash, buildDuplicateHashSet } = require('../utils/transactionHash');
const {
    DEFAULT_AUTO_PROMOTE_THRESHOLD,
    DEFAULT_REVIEW_THRESHOLD,
    TOP_N_SEEDS,
    PHASE2_CONCURRENCY,
} = require('../config/classificationConfig');

const ROW_BATCH_SIZE = 20;
const INVESTMENT_HINTS = new Set(['API_STOCK', 'API_CRYPTO', 'MANUAL']);

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE DETECTION — imported from utils/transactionHash.js
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// NAME / ID RESOLUTION (native adapter)
// ═══════════════════════════════════════════════════════════════════════════════

function resolveId(value, nameMap, idSet) {
    if (!value || typeof value !== 'string' || value.trim() === '') return null;
    const asInt = parseInt(value.trim(), 10);
    if (!isNaN(asInt) && idSet.has(asInt)) return asInt;
    return nameMap.get(value.trim().toLowerCase()) ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FREQUENCY HELPERS (shared with Plaid worker pattern)
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeDescription(desc) {
    return (desc || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Group an array of {description, ...} entries by normalized description.
 * Returns Map<normalizedDesc, entry[]>
 */
function buildAiFrequencyMap(entries) {
    const map = new Map();
    for (const entry of entries) {
        const key = normalizeDescription(entry.description);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(entry);
    }
    return map;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE STATUS HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check a row's hash against the known-hash set and mutate its status when a
 * collision is found. Rows whose source date carries a wall-clock timestamp
 * are treated as hard duplicates (`DUPLICATE` — hidden from the Review UI by
 * default). Date-only rows are flagged `POTENTIAL_DUPLICATE` — surfaced in
 * the UI with a warning badge so the user can explicitly override them to
 * CONFIRMED if they really are distinct transactions.
 *
 * The first occurrence of a given hash is added to the set so that subsequent
 * rows in the same CSV with the same hash are also flagged as intra-CSV dups.
 *
 * @param {object} rowData — Staged row being built; status is mutated in place
 * @param {Set<string>} hashSet — Known hashes (existing DB + prior CSV rows)
 * @param {string} hash — This row's transaction hash
 * @param {boolean} hasTime — True when the parsed date carried a time component
 * @returns {boolean} true when the row was flagged as a duplicate
 */
function applyDuplicateStatus(rowData, hashSet, hash, hasTime) {
    if (hashSet.has(hash)) {
        rowData.status = hasTime ? 'DUPLICATE' : 'POTENTIAL_DUPLICATE';
        return true;
    }
    hashSet.add(hash);
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply a classification result to a rowData object in-place.
 * Handles investment detection and auto-confirm logic.
 */
function applyClassificationToRowData(rowData, result, autoPromoteThreshold, categoryById) {
    const suggestedCategory = categoryById.get(result.categoryId);
    const isInvestmentCategory = suggestedCategory &&
        suggestedCategory.type === 'Investments' &&
        INVESTMENT_HINTS.has(suggestedCategory.processingHint);

    rowData.suggestedCategoryId = result.categoryId;
    rowData.confidence = result.confidence;
    rowData.classificationSource = result.source;

    if (isInvestmentCategory) {
        rowData.requiresEnrichment = true;
        rowData.enrichmentType = 'INVESTMENT';
    }

    // Auto-confirm high-confidence results from any source.
    // Investment rows are NEVER auto-confirmed — they require user enrichment.
    if (
        !isInvestmentCategory &&
        result.confidence >= autoPromoteThreshold &&
        rowData.status === 'PENDING'
    ) {
        rowData.status = 'CONFIRMED';
        return true; // signals autoConfirmed
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE DIFF COMPUTATION (CSV round-trip)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compare CSV row values against an existing transaction.
 * Returns an object with only changed fields. Empty object = no changes.
 *
 * Empty string in CSV for optional fields means "clear that field" (compare against null).
 *
 * @param {object} csvRow  - Parsed row from adapter engine (date, description, debit, credit, etc.)
 * @param {object} existingTx - Transaction from DB with category and tags relations
 * @param {number|null} resolvedCategoryId - Category ID resolved from CSV column
 * @param {Map} categoryById - Map<categoryId, category> for name lookups
 * @returns {object} diff - Only changed fields: { fieldName: { old, new, oldName?, newName? } }
 */
function computeUpdateDiff(csvRow, existingTx, resolvedCategoryId, categoryById) {
    const diff = {};

    // description (required — always present)
    const csvDesc = (csvRow.description || '').trim();
    const txDesc = (existingTx.description || '').trim();
    if (csvDesc !== txDesc) {
        diff.description = { old: existingTx.description, new: csvRow.description };
    }

    // details (optional — empty string = clear → compare against null)
    const csvDetails = csvRow.details || null;
    const txDetails = existingTx.details || null;
    if ((csvDetails || '') !== (txDetails || '')) {
        diff.details = { old: txDetails, new: csvDetails };
    }

    // amounts (Decimal comparison)
    const csvDebit = csvRow.debit ? parseFloat(csvRow.debit) : null;
    const txDebit = existingTx.debit ? parseFloat(existingTx.debit) : null;
    if (csvDebit !== txDebit) {
        diff.debit = { old: txDebit, new: csvDebit };
    }

    const csvCredit = csvRow.credit ? parseFloat(csvRow.credit) : null;
    const txCredit = existingTx.credit ? parseFloat(existingTx.credit) : null;
    if (csvCredit !== txCredit) {
        diff.credit = { old: txCredit, new: csvCredit };
    }

    // categoryId (with human-readable names)
    if (resolvedCategoryId && resolvedCategoryId !== existingTx.categoryId) {
        const oldCat = categoryById.get(existingTx.categoryId);
        const newCat = categoryById.get(resolvedCategoryId);
        diff.categoryId = {
            old: existingTx.categoryId,
            new: resolvedCategoryId,
            oldName: oldCat?.name || null,
            newName: newCat?.name || null,
        };
    }

    // transactionDate (day-level comparison)
    const csvDate = new Date(csvRow.date);
    const txDate = new Date(existingTx.transaction_date);
    if (csvDate.toISOString().slice(0, 10) !== txDate.toISOString().slice(0, 10)) {
        diff.transactionDate = {
            old: txDate.toISOString().slice(0, 10),
            new: csvDate.toISOString().slice(0, 10),
        };
    }

    // currency
    const csvCurrency = (csvRow.currency || '').toUpperCase();
    const txCurrency = (existingTx.currency || '').toUpperCase();
    if (csvCurrency && csvCurrency !== txCurrency) {
        diff.currency = { old: existingTx.currency, new: csvCurrency };
    }

    // tags (set comparison of tag names)
    const existingTagNames = (existingTx.tags || [])
        .map(t => (t.tag ? t.tag.name : t.name) || '')
        .filter(Boolean)
        .sort();
    const csvTagNames = (csvRow.tags || []).map(t => String(t).trim()).filter(Boolean).sort();
    if (JSON.stringify(existingTagNames) !== JSON.stringify(csvTagNames)) {
        diff.tags = { old: existingTagNames, new: csvTagNames };
    }

    // ticker (null-safe)
    const csvTicker = csvRow.ticker && /[a-zA-Z]/.test(String(csvRow.ticker))
        ? String(csvRow.ticker).trim()
        : null;
    if ((csvTicker || null) !== (existingTx.ticker || null)) {
        diff.ticker = { old: existingTx.ticker || null, new: csvTicker };
    }

    // assetQuantity (null-safe decimal)
    const csvQty = csvRow.assetQuantity ? parseFloat(csvRow.assetQuantity) : null;
    const txQty = existingTx.assetQuantity ? parseFloat(existingTx.assetQuantity) : null;
    if (csvQty !== txQty) {
        diff.assetQuantity = { old: txQty, new: csvQty };
    }

    // assetPrice (null-safe decimal)
    const csvPrice = csvRow.assetPrice ? parseFloat(csvRow.assetPrice) : null;
    const txPrice = existingTx.assetPrice ? parseFloat(existingTx.assetPrice) : null;
    if (csvPrice !== txPrice) {
        diff.assetPrice = { old: txPrice, new: csvPrice };
    }

    return diff;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER JOB PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

const processSmartImportJob = async (job) => {
    const { tenantId, userId, accountId, adapterId, fileStorageKey, stagedImportId } = job.data;

    // Initialize storage lazily so @google-cloud/storage is only required at job
    // execution time, not at module load time (avoids startup failure when the
    // package is present in node_modules but not yet resolvable during boot).
    let storage;
    try {
        storage = createStorageAdapter();
    } catch (error) {
        logger.error('Failed to initialize storage adapter for Smart Import Worker:', error);
        throw new Error('Storage service is not configured.');
    }

    // p-limit is ESM-only; dynamic import works inside async CJS functions
    const { default: pLimit } = await import('p-limit');

    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { autoPromoteThreshold: true, reviewThreshold: true },
    });
    const autoPromoteThreshold = tenant?.autoPromoteThreshold ?? DEFAULT_AUTO_PROMOTE_THRESHOLD;
    const reviewThreshold = tenant?.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;

    logger.info(`Processing smart import job for tenant ${tenantId}`, {
        adapterId, accountId, stagedImportId, file: fileStorageKey,
    });

    const ext = path.extname(fileStorageKey).toLowerCase().replace('.', '') || 'csv';
    const fileType = (ext === 'xlsx' || ext === 'xls') ? ext : 'csv';
    const tempFilePath = path.join(os.tmpdir(), `bliss-smart-import-${uuidv4()}.${ext}`);

    try {
        // ── Step 1: Download file from storage ─────────────────────────────────────
        await storage.downloadFile(fileStorageKey, tempFilePath);
        logger.info(`Downloaded ${fileStorageKey} to ${tempFilePath}`);

        // ── Step 2: Load adapter from DB ──────────────────────────────────────────
        const adapter = await prisma.importAdapter.findUnique({ where: { id: adapterId } });
        if (!adapter) throw new Error(`Adapter ${adapterId} not found`);

        // ── Step 3: Parse file using adapter engine ───────────────────────────────
        const fileContent = fileType === 'csv'
            ? fs.readFileSync(tempFilePath, 'utf8')
            : fs.readFileSync(tempFilePath);
        const { rows: normalizedRows, hasTimeInDates } = await parseFile(fileContent, adapter, fileType);

        if (normalizedRows.length === 0) {
            await prisma.stagedImport.update({
                where: { id: stagedImportId },
                data: { status: 'READY', totalRows: 0 },
            });
            logger.warn(`No data rows found in file for tenant ${tenantId}.`);
            return { stagedImportId, totalRows: 0, errorCount: 0 };
        }

        const isNativeAdapter = adapter?.matchSignature?.isNative === true;

        // ── Step 3b: Detect update-only imports ──────────────────────────────────
        // When every row has a valid `id` column (CSV round-trip), we can skip the
        // expensive description cache warming and duplicate hash building since
        // update rows need neither classification nor dedup.
        let isUpdateOnly = false;
        if (isNativeAdapter) {
            const rowsWithId = normalizedRows.filter(r => {
                if (!r.rawData) return false;
                const idKey = Object.keys(r.rawData).find(k => k.toLowerCase() === 'id');
                if (!idKey) return false;
                const parsed = parseInt(r.rawData[idKey], 10);
                return !isNaN(parsed) && parsed > 0;
            });
            isUpdateOnly = rowsWithId.length === normalizedRows.length;
            if (isUpdateOnly) {
                logger.info(`[SmartImport] Update-only import detected (${normalizedRows.length} rows) — skipping description cache + dedup`);
            }
        }

        // ── Step 4: Warm description cache + pre-fetch categories ─────────────────
        // Skip the expensive description cache for update-only imports (no classification needed)
        if (!isUpdateOnly) {
            await warmDescriptionCache(tenantId);
        }

        const tenantCategories = await getCategoriesForTenant(tenantId);
        const categoryById = new Map(tenantCategories.map(c => [c.id, c]));

        // ── Step 4c: Native adapter name/ID maps ─────────────────────────────────
        let accountNameToId, accountIdSet, categoryNameToId, categoryIdSet;
        if (isNativeAdapter) {
            const [accounts, categories] = await Promise.all([
                prisma.account.findMany({ where: { tenantId }, select: { id: true, name: true } }),
                prisma.category.findMany({ where: { tenantId }, select: { id: true, name: true } }),
            ]);
            accountNameToId  = new Map(accounts.map(a => [a.name.toLowerCase(), a.id]));
            accountIdSet     = new Set(accounts.map(a => a.id));
            categoryNameToId = new Map(categories.map(c => [c.name.toLowerCase(), c.id]));
            categoryIdSet    = new Set(categories.map(c => c.id));
            logger.info(`Native adapter mode: loaded ${accounts.length} accounts and ${categories.length} categories`);
        }

        // ── Step 5: Build duplicate detection hash Set ────────────────────────────
        // Skip for update-only imports (no dedup needed)
        let csvMinDate = null;
        let csvMaxDate = null;
        if (!isUpdateOnly) {
            const csvDates = normalizedRows.map(r => r.date).filter(Boolean);
            if (csvDates.length > 0) {
                const timestamps = csvDates.map(d => (d instanceof Date ? d : new Date(d)).getTime());
                csvMinDate = new Date(Math.min(...timestamps));
                csvMaxDate = new Date(Math.max(...timestamps));
            }
        }

        const duplicateHashSet = (accountId && !isUpdateOnly)
            ? await buildDuplicateHashSet(tenantId, accountId, csvMinDate, csvMaxDate)
            : new Set();

        const perAccountHashCache = new Map();

        // ── Step 5b: Pre-fetch existing transactions for update ID validation ────
        // For native adapter CSVs that include an `id` column, batch-fetch all
        // referenced transactions so the Phase 0 loop can validate + diff in O(1).
        let transactionMap = null;
        let updateRowCount = 0;

        if (isNativeAdapter) {
            const updateIds = [];
            for (const row of normalizedRows) {
                if (!row.rawData) continue;
                const rawIdKey = Object.keys(row.rawData).find(k => k.toLowerCase() === 'id');
                if (rawIdKey) {
                    const parsed = parseInt(row.rawData[rawIdKey], 10);
                    if (!isNaN(parsed) && parsed > 0) updateIds.push(parsed);
                }
            }
            if (updateIds.length > 0) {
                const uniqueIds = [...new Set(updateIds)];
                const existingTxs = await prisma.transaction.findMany({
                    where: { id: { in: uniqueIds }, tenantId },
                    include: {
                        category: { select: { id: true, name: true } },
                        tags: { include: { tag: { select: { name: true } } } },
                    },
                });
                transactionMap = new Map(existingTxs.map(tx => [tx.id, tx]));
                logger.info(`[SmartImport] Pre-fetched ${existingTxs.length}/${uniqueIds.length} transactions for update validation`);
            }
        }

        // ── Step 6: First pass — validate, dedup, native classification ───────────
        // AI rows are collected for Phase 1/2 classification below.
        // This separates data prep from AI calls, allowing frequency-based ordering.

        // Progress reporter — writes at most once per second regardless of
        // row count. Row-count strides (e.g. "every 5%" or "every 50 rows")
        // either spam Prisma on small imports or leave the bar frozen for
        // tens of seconds on large ones; a time-based throttle keeps the
        // cadence smooth at any scale (~1 update/s) and the write itself is
        // a single-row UPDATE by PK so it's essentially free.
        // `force` bypasses the throttle — use it for guaranteed-land values
        // like the start (1%) and end-of-phase boundaries.
        let lastProgressWriteMs = 0;
        const PROGRESS_MIN_INTERVAL_MS = 1000;
        const reportProgress = async (pct, { force = false } = {}) => {
            const now = Date.now();
            if (!force && now - lastProgressWriteMs < PROGRESS_MIN_INTERVAL_MS) return;
            lastProgressWriteMs = now;
            await job.updateProgress(pct);
            await prisma.stagedImport.update({
                where: { id: stagedImportId },
                data: { progress: pct },
            });
        };

        await reportProgress(1, { force: true });

        const allRowData = [];     // Complete list of rowData objects (all rows)
        const aiEntries = [];      // Subset of allRowData entries needing AI classification
        let errorCount = 0;
        let duplicateCount = 0;

        for (let i = 0; i < normalizedRows.length; i++) {
            const row = normalizedRows[i];

            const rowData = {
                stagedImportId,
                rowNumber: i + 1,
                rawData: row.rawData,
                transactionDate: row.date,
                description: row.description,
                debit: row.debit,
                credit: row.credit,
                currency: row.currency,
                accountId,
                tags: row.tags || null,
                status: 'PENDING',
                suggestedCategoryId: null,
                confidence: null,
                classificationSource: null,
                errorMessage: null,
                duplicateOfId: null,
            };

            // Validate required fields
            if (!row.date) {
                rowData.status = 'ERROR';
                rowData.errorMessage = 'Missing or invalid date';
                errorCount++;
                allRowData.push(rowData);
                continue;
            }
            if (!row.debit && !row.credit) {
                rowData.status = 'ERROR';
                rowData.errorMessage = 'Missing amount (no debit or credit value)';
                errorCount++;
                allRowData.push(rowData);
                continue;
            }

            // Duplicate detection (non-native path)
            const amount = row.debit || row.credit;
            if (!isNativeAdapter) {
                const hash = computeTransactionHash(row.date, row.description, amount, accountId);
                // Rows flagged here are still classified so the user can see the
                // suggested category if they choose to override POTENTIAL_DUPLICATE
                // rows to CONFIRMED. DUPLICATE rows are hidden from the UI by the
                // GET /api/imports/[id] endpoint's default status filter.
                if (applyDuplicateStatus(rowData, duplicateHashSet, hash, !!row.hasTime)) {
                    duplicateCount++;
                }
            }

            if (isNativeAdapter) {
                // ── Check for update ID in rawData (CSV round-trip) ──
                const rawIdKey = row.rawData ? Object.keys(row.rawData).find(k => k.toLowerCase() === 'id') : null;
                const updateId = rawIdKey ? parseInt(row.rawData[rawIdKey], 10) : null;

                if (updateId && !isNaN(updateId) && transactionMap) {
                    const existingTx = transactionMap.get(updateId);
                    if (!existingTx) {
                        rowData.status = 'ERROR';
                        rowData.errorMessage = 'Transaction not found or belongs to another tenant';
                        errorCount++;
                        allRowData.push(rowData);
                        continue;
                    }

                    // Resolve category only (account is IGNORED for updates — keeps original)
                    const resolvedCategoryId = resolveId(row.category, categoryNameToId, categoryIdSet);
                    rowData.accountId            = existingTx.accountId;
                    rowData.suggestedCategoryId  = resolvedCategoryId;
                    rowData.confidence           = resolvedCategoryId ? 1.0 : 0;
                    rowData.classificationSource = resolvedCategoryId ? 'USER_OVERRIDE' : null;
                    rowData.details              = row.details;  // empty string = clear field
                    rowData.ticker               = row.ticker && /[a-zA-Z]/.test(String(row.ticker).trim())
                                                     ? String(row.ticker).trim() : null;
                    rowData.assetQuantity        = row.assetQuantity || null;
                    rowData.assetPrice           = row.assetPrice || null;
                    rowData.requiresEnrichment   = false;
                    rowData.updateTargetId       = updateId;

                    // Compute diff — skip row if nothing changed
                    const diff = computeUpdateDiff(row, existingTx, resolvedCategoryId, categoryById);
                    if (Object.keys(diff).length === 0) {
                        rowData.status = 'SKIPPED';
                        rowData.errorMessage = 'No changes detected';
                        allRowData.push(rowData);
                        continue;
                    }

                    rowData.updateDiff = diff;
                    if (resolvedCategoryId) {
                        rowData.status = 'CONFIRMED';
                    } else {
                        rowData.errorMessage = 'Could not resolve category from CSV value';
                    }

                    updateRowCount++;
                    allRowData.push(rowData);
                    continue;  // Skip dedup + normal native path
                }

                // Native adapter: resolve account + category from CSV columns
                const resolvedAccountId  = resolveId(row.account,   accountNameToId, accountIdSet)  ?? accountId;
                const resolvedCategoryId = resolveId(row.category, categoryNameToId, categoryIdSet);

                rowData.accountId            = resolvedAccountId;
                rowData.suggestedCategoryId  = resolvedCategoryId;
                rowData.confidence           = resolvedCategoryId ? 1.0 : 0;
                rowData.classificationSource = resolvedCategoryId ? 'USER_OVERRIDE' : null;
                rowData.details              = row.details || null;
                // Validate ticker contains at least one letter — pure numeric values like "0"
                // are common CSV placeholders for "not applicable" and are not valid tickers.
                rowData.ticker               = row.ticker && /[a-zA-Z]/.test(String(row.ticker).trim()) ? String(row.ticker).trim() : null;
                rowData.assetQuantity        = row.assetQuantity || null;
                rowData.assetPrice           = row.assetPrice    || null;
                rowData.requiresEnrichment   = false;

                // Per-row duplicate detection for native adapter
                if (resolvedAccountId) {
                    if (!perAccountHashCache.has(resolvedAccountId)) {
                        perAccountHashCache.set(
                            resolvedAccountId,
                            await buildDuplicateHashSet(tenantId, resolvedAccountId, csvMinDate, csvMaxDate),
                        );
                    }
                    const acctHashSet = perAccountHashCache.get(resolvedAccountId);
                    const nativeHash = computeTransactionHash(row.date, row.description, amount, resolvedAccountId);

                    if (i === 0) {
                        const isoDate = row.date instanceof Date ? row.date.toISOString() : new Date(row.date).toISOString();
                        logger.info(
                            `Native dedup — CSV row 0: date=${isoDate}, desc="${(row.description || '').substring(0, 30)}", ` +
                            `amount=${String(parseFloat(amount) || 0)}, accountId=${resolvedAccountId}, ` +
                            `hash=${nativeHash.substring(0, 12)}..., hashSetSize=${acctHashSet.size}, match=${acctHashSet.has(nativeHash)}`
                        );
                    }

                    if (applyDuplicateStatus(rowData, acctHashSet, nativeHash, !!row.hasTime)) {
                        duplicateCount++;
                    }
                }

                if (resolvedCategoryId && resolvedAccountId && rowData.status === 'PENDING') {
                    rowData.status = 'CONFIRMED';
                } else if (!resolvedCategoryId || !resolvedAccountId) {
                    const missing = [];
                    if (!resolvedAccountId)  missing.push('account');
                    if (!resolvedCategoryId) missing.push('category');
                    rowData.errorMessage = `Could not resolve ${missing.join(' or ')} from CSV value`;
                }
            } else if (row.description) {
                // AI rows: collect for Phase 1/2 (do NOT classify here)
                aiEntries.push({ rowData, description: row.description });
            }

            allRowData.push(rowData);

            // First-pass progress: 1% → 19% while we normalize, dedup, and
            // resolve native-adapter rows. Without this, large imports sat
            // at 1% for the entire duration of this loop before jumping to
            // 30% when Phase 1 finished. Time-throttled so even a 15k-row
            // import stays continuously updating.
            // Ceiling is 19% (not 29%) to reserve 20→29 for Phase 1's LLM
            // seed interview — that loop used to run silently for 100+
            // seconds between this bar and the jump to 30%.
            const pct = Math.min(19, 1 + Math.floor(((i + 1) / normalizedRows.length) * 18));
            await reportProgress(pct);
        }

        // ── Phase 1: Frequency-First Seed Classification ──────────────────────────
        // Classify one representative per unique description (most-frequent first).
        // EXACT_MATCH / VECTOR_MATCH hits: apply result, skip interview.
        // LLM hits: apply result, add to seed interview list (up to TOP_N_SEEDS).
        let seedCount = 0;
        let autoConfirmedCount = 0;
        let classifiedCount = 0;

        const aiFreqMap = buildAiFrequencyMap(aiEntries);
        const sortedDescAi = [...aiFreqMap.entries()].sort((a, b) => b[1].length - a[1].length);
        const phase1Start = Date.now();

        // Progress band for Phase 1: 20% → 29%. Each LLM classify call can
        // take 3-5s (sometimes longer), and the loop runs up to TOP_N_SEEDS
        // slow iterations plus any fast EXACT/VECTOR hits. Denominator is
        // whichever completes first so the bar fills smoothly in both the
        // small-list-all-LLM case (e.g. 5 unique desc → 5 slow iters fill
        // 5/5 of the band) and the large-list-with-cache-hits case (many
        // fast iters + up to TOP_N_SEEDS slow ones → bar caps at 29%).
        const phase1Denom = Math.max(1, Math.min(sortedDescAi.length, TOP_N_SEEDS));
        let phase1Done = 0;

        for (const [normalizedName, entries] of sortedDescAi) {
            if (seedCount >= TOP_N_SEEDS) break;

            const rep = entries[0];
            try {
                // ONE classify() call per unique description
                const result = await categorizationService.classify(
                    rep.description,
                    null, // No merchantName for CSV imports
                    tenantId,
                    reviewThreshold,
                );

                // Apply to all rows with this description
                for (const entry of entries) {
                    const wasAutoConfirmed = applyClassificationToRowData(
                        entry.rowData, result, autoPromoteThreshold, categoryById
                    );
                    if (wasAutoConfirmed) autoConfirmedCount++;
                    classifiedCount++;
                }

                if (result.source === 'LLM') {
                    seedCount++;
                }
            } catch (classifyError) {
                logger.warn(`Phase 1 classify failed for "${normalizedName}": ${classifyError.message}`);
                // Leave rowData.classificationSource = null — user will classify manually
            }

            // Tick progress after each iteration so the bar advances even
            // when the loop is blocked on slow LLM calls. The 1s throttle
            // in reportProgress() keeps the Prisma write cadence sane.
            phase1Done++;
            const pct = Math.min(29, 20 + Math.floor((phase1Done / phase1Denom) * 9));
            await reportProgress(pct);
        }

        logger.info(
            `[Phase 1] Import ${stagedImportId}: ${seedCount} LLM seeds in ${Date.now() - phase1Start}ms`
        );

        // ── Signal frontend: Quick Seed interview can be shown ────────────────────
        // seedReady = true even if seedCount = 0 (all hit Tier 1/2 — interview skipped)
        // NOTE: we update `seedReady` separately from the generic progress
        // reporter because the boolean field must land with the progress
        // write regardless of the time-throttle.
        await prisma.stagedImport.update({
            where: { id: stagedImportId },
            data: { seedReady: true, progress: 30 },
        });
        await job.updateProgress(30);
        lastProgressWriteMs = Date.now(); // keep the throttle in sync with the manual write above

        // ── Phase 2: Parallel Classification of Remaining AI Rows ─────────────────
        // Rows not touched by Phase 1 (still have classificationSource === null).
        // Sorted ASCENDING by frequency — rarest merchants first, semi-frequent last.
        const remainingAiEntries = aiEntries.filter(e => e.rowData.classificationSource === null);

        if (remainingAiEntries.length > 0) {
            const phase2FreqMap = buildAiFrequencyMap(remainingAiEntries);
            // ASCENDING: least-frequent groups first → most-frequent last
            const sortedAsc = [...phase2FreqMap.entries()]
                .sort((a, b) => a[1].length - b[1].length)
                .flatMap(([, entries]) => entries);

            const limit = pLimit(PHASE2_CONCURRENCY);
            let phase2Done = 0;
            const phase2Start = Date.now();

            await Promise.all(
                sortedAsc.map(entry => limit(async () => {
                    try {
                        const result = await categorizationService.classify(
                            entry.description,
                            null,
                            tenantId,
                            reviewThreshold,
                        );
                        const wasAutoConfirmed = applyClassificationToRowData(
                            entry.rowData, result, autoPromoteThreshold, categoryById
                        );
                        if (wasAutoConfirmed) autoConfirmedCount++;
                        classifiedCount++;
                    } catch (classifyError) {
                        logger.warn(
                            `Phase 2 classify failed for "${entry.description}": ${classifyError.message}`
                        );
                        // rowData stays with no category — user must manually assign
                    }
                    phase2Done++;
                    const pct = 30 + Math.round((phase2Done / sortedAsc.length) * 50);
                    await reportProgress(pct, { force: phase2Done === sortedAsc.length });
                }))
            );

            logger.info(
                `[Phase 2] Import ${stagedImportId}: ${remainingAiEntries.length} rows in ${Date.now() - phase2Start}ms`
            );
        }

        // ── Step 6b: Ticker metadata resolution ───────────────────────────────────
        // For rows that already carry a ticker (native adapter imports), resolve
        // exchange (MIC code), assetCurrency, and ISIN from TwelveData at staging
        // time so the data is available at commit without any user interaction.
        // Only runs for market-priced asset types (API_STOCK, API_CRYPTO, API_FUND).
        // MANUAL assets are excluded — their ticker is a composite key, not a real
        // market symbol, and TwelveData would return no results for them.
        // This is best-effort: a failed lookup leaves the fields null and never
        // blocks the import from completing.
        const TICKER_RESOLVE_HINTS = new Set(['API_STOCK', 'API_CRYPTO', 'API_FUND']);
        const tickerRowsToResolve = allRowData.filter((r) => {
            if (!r.ticker || r.isin) return false;
            const hint = r.suggestedCategoryId ? categoryById.get(r.suggestedCategoryId)?.processingHint : null;
            return TICKER_RESOLVE_HINTS.has(hint);
        });

        if (tickerRowsToResolve.length > 0) {
            // Pre-group rows by ticker to avoid O(N×M) scans inside the loop.
            const rowsByTicker = new Map();
            for (const r of tickerRowsToResolve) {
                if (!rowsByTicker.has(r.ticker)) rowsByTicker.set(r.ticker, []);
                rowsByTicker.get(r.ticker).push(r);
            }

            logger.info(`[SmartImport] Resolving ticker metadata for ${rowsByTicker.size} unique ticker(s)...`);

            // Resolve tickers in parallel with controlled concurrency (5 at a time)
            // to avoid TwelveData rate limits while being much faster than sequential.
            const TICKER_CONCURRENCY = 5;
            const tickerEntries = [...rowsByTicker.entries()];

            const resolveSingleTicker = async ([ticker, rows]) => {
                try {
                    const hint = rows[0]?.suggestedCategoryId
                        ? categoryById.get(rows[0].suggestedCategoryId)?.processingHint
                        : null;
                    const isCrypto = hint === 'API_CRYPTO';

                    if (isCrypto) {
                        const cryptoCandidates = await cryptoService.searchCrypto(ticker);
                        if (cryptoCandidates.length === 0) return;
                        const best = cryptoCandidates[0];
                        logger.info(
                            `[SmartImport] Resolved crypto "${ticker}" → base symbol "${best.symbol}" ` +
                            `(${cryptoCandidates.length} candidate(s))`
                        );
                        for (const rowData of rows) {
                            if (best.symbol) rowData.ticker = best.symbol;
                        }
                    } else {
                        // Cache-first: check SecurityMaster before calling Twelve Data
                        const cached = await securityMasterService.getBySymbol(ticker);
                        const hasFreshCache = cached && cached.lastProfileUpdate &&
                            (Date.now() - new Date(cached.lastProfileUpdate).getTime()) < 7 * 86400000;

                        let exchange, assetCurrency, isin;

                        if (hasFreshCache) {
                            // Use cached SecurityMaster data — saves API credits
                            exchange = cached.exchange || null;
                            assetCurrency = cached.currency || null;
                            isin = cached.isin || null;
                            logger.info(
                                `[SmartImport] Resolved "${ticker}" from SecurityMaster cache: ` +
                                `exchange=${exchange}, currency=${assetCurrency}, isin=${isin}`
                            );
                        } else {
                            // Cache miss or stale — resolve via Twelve Data
                            // Step 1: search to find the correct exchange
                            const candidates = await twelveDataService.searchSymbol(ticker);
                            if (candidates.length === 0) return;

                            const rowCurrencies = new Set(rows.filter((r) => r.currency).map((r) => r.currency));
                            const best =
                                candidates.find((c) => rowCurrencies.has(c.currency)) ||
                                candidates.find((c) => c.symbol.toUpperCase() === ticker.toUpperCase()) ||
                                candidates[0];

                            exchange = best.mic_code || best.exchange || null;
                            assetCurrency = best.currency || null;

                            // Step 2: fetch profile WITH the correct MIC code so we get
                            // the right company (e.g. AIR on XPAR, not AIR on XNYS)
                            const micOpts = exchange ? { micCode: exchange } : {};
                            const profile = await twelveDataService.getSymbolProfile(ticker, micOpts);
                            isin = profile?.isin ?? null;

                            logger.info(
                                `[SmartImport] Resolved "${ticker}" via Twelve Data: ` +
                                `exchange=${exchange}, assetCurrency=${assetCurrency}, isin=${isin} ` +
                                `(${candidates.length} candidate(s), picked "${best.symbol}" on ${best.exchange})`
                            );

                            // Fire-and-forget: populate SecurityMaster cache for future lookups
                            if (profile) {
                                // Ensure the resolved MIC code is stored even if
                                // /profile returned a different one or none at all.
                                if (exchange) {
                                    profile.knownMicCode = exchange;
                                }
                                securityMasterService.upsertFromProfile(ticker, profile).catch(err => {
                                    logger.error(`[SmartImport] Failed to cache profile for ${ticker}`, { error: err.message });
                                });
                            }
                        }

                        for (const rowData of rows) {
                            if (exchange)      rowData.exchange      = exchange;
                            if (assetCurrency) rowData.assetCurrency = assetCurrency;
                            if (isin)          rowData.isin          = isin;
                        }
                    }
                } catch (tickerErr) {
                    logger.warn(`[SmartImport] Ticker resolution failed for "${ticker}": ${tickerErr.message}`);
                }
            };

            // Process in batches of TICKER_CONCURRENCY
            for (let i = 0; i < tickerEntries.length; i += TICKER_CONCURRENCY) {
                const batch = tickerEntries.slice(i, i + TICKER_CONCURRENCY);
                await Promise.all(batch.map(resolveSingleTicker));
            }

            logger.info(`[SmartImport] Ticker metadata resolution complete.`);
        }

        // Persist the 90% milestone (end of ticker resolution, before
        // Step 7 batch insert). Forced write so the bar is guaranteed to
        // advance here even if the last Phase 2 tick fired recently.
        await reportProgress(90, { force: true });

        // ── Step 7: Batch insert all staged rows ──────────────────────────────────
        // NOTE: Embeddings are intentionally NOT saved here — only at commit time after
        // the user confirms categories. This avoids indexing unconfirmed classifications.
        let insertBatch = [];
        for (let i = 0; i < allRowData.length; i++) {
            insertBatch.push(allRowData[i]);
            if (insertBatch.length >= ROW_BATCH_SIZE) {
                await prisma.stagedImportRow.createMany({ data: insertBatch });
                insertBatch = [];
            }
        }
        if (insertBatch.length > 0) {
            await prisma.stagedImportRow.createMany({ data: insertBatch });
        }

        await job.updateProgress(100);

        // ── Step 8: Update StagedImport status → READY ────────────────────────────
        await prisma.stagedImport.update({
            where: { id: stagedImportId },
            data: {
                status: 'READY',
                totalRows: normalizedRows.length,
                progress: 100,
                errorCount,
                autoConfirmedCount,
                updateCount: updateRowCount,
            },
        });

        logger.info(
            `Smart import complete for ${stagedImportId}. ` +
            `${normalizedRows.length} rows: ${classifiedCount} classified (${seedCount} LLM seeds), ` +
            `${autoConfirmedCount} auto-confirmed, ${duplicateCount} duplicates, ${errorCount} errors. Status: READY`
        );

        // ── Storage cleanup on success only (so retries still have the file) ──
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await storage.deleteFile(fileStorageKey);
                logger.info(`Cleaned up stored file: ${fileStorageKey}`);
                break;
            } catch (e) {
                if (attempt === 0) {
                    logger.warn(`Storage delete attempt 1 failed, retrying in 2s: ${fileStorageKey}`);
                    await new Promise(r => setTimeout(r, 2000));
                } else {
                    logger.warn({ key: fileStorageKey, tenantId, importId: stagedImportId, error: e.message },
                        `Storage file cleanup failed after 2 attempts`);
                }
            }
        }

        return {
            stagedImportId,
            totalRows: normalizedRows.length,
            classifiedCount,
            autoConfirmedCount,
            duplicateCount,
            errorCount,
        };
    } catch (error) {
        try {
            await prisma.stagedImport.update({
                where: { id: stagedImportId },
                data: { status: 'ERROR', errorDetails: { message: error.message } },
            });
        } catch (updateErr) {
            logger.error(`Failed to update StagedImport ${stagedImportId} to ERROR: ${updateErr.message}`);
        }

        logger.error(`Smart import job failed for ${stagedImportId}: ${error.message}`);
        throw error;
    } finally {
        // Cleanup temp file only — GCS file preserved for retries on failure
        try { fs.unlinkSync(tempFilePath); } catch (e) { logger.warn(`Failed to cleanup temp file: ${tempFilePath}`); }
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

const startSmartImportWorker = () => {
    logger.info('Starting Smart Import Worker...');

    // Lazy-require commitWorker to avoid circular dependency at module load time
    const { processCommitJob } = require('./commitWorker');

    // Dispatcher routes by job name: commit vs. processing
    const dispatchJob = async (job) => {
        if (job.name === 'commit-smart-import') {
            return processCommitJob(job);
        }
        return processSmartImportJob(job);
    };

    const worker = new Worker(SMART_IMPORT_QUEUE_NAME, dispatchJob, {
        connection: getRedisConnection(),
        concurrency: 1,
        lockDuration: 600_000,      // 10 min — large imports with ticker API calls need time
        lockRenewTime: 150_000,     // renew every 2.5 min (well before 10 min expiry)
    });

    worker.on('completed', (job, result) => {
        logger.info(`Smart Import job completed`, { jobId: job.id, result });
    });

    worker.on('failed', (job, error) => {
        reportWorkerFailure({
            workerName: 'smartImportWorker',
            job,
            error,
            extra: {
                stagedImportId: job?.data?.stagedImportId,
                adapterId: job?.data?.adapterId,
            },
        });
    });

    worker.on('progress', (job, progress) => {
        logger.info(`Smart Import progress for ${job.data.stagedImportId}`, {
            jobId: job.id, progress: `${progress}%`,
        });
    });

    logger.info(`Smart Import Worker started on queue: ${SMART_IMPORT_QUEUE_NAME}`);

    // Return worker reference so index.js can close it before disconnecting Redis
    return worker;
};

module.exports = {
    startSmartImportWorker,
    computeTransactionHash,
    // Exported for testing
    applyClassificationToRowData,
    applyDuplicateStatus,
    computeUpdateDiff,
    buildAiFrequencyMap,
};
