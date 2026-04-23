const { Decimal } = require('@prisma/client/runtime/library');
const prisma = require('../../../prisma/prisma.js');
const logger = require('../../utils/logger');
const { generateAssetKey } = require('./asset-aggregator');
const { enqueueEvent } = require('../../queues/eventsQueue');
const { decrypt } = require('../../utils/encryption');
const { calculatePortfolioItemState } = require('../../utils/portfolioItemStateCalculator.js');
const { getRatesForDateRange } = require('../../services/currencyService.js');

/**
 * Creates ManualAssetValue records for each buy transaction of a MANUAL-source item,
 * using a running weighted average price (cumulative_cost / cumulative_qty).
 * This gives the valuation pipeline a concrete price to forward-fill from.
 *
 * @param {number} portfolioItemId - The PortfolioItem ID
 * @param {string} tenantId - The tenant ID
 * @param {Array<object>} transactions - Buy transactions sorted by date (ascending)
 */
const seedManualAssetValues = async (portfolioItemId, tenantId, transactions) => {
    let runningQty = new Decimal(0);
    let runningCost = new Decimal(0);
    const records = [];

    for (const tx of transactions) {
        if (!tx.debit || !new Decimal(tx.debit).gt(0)) continue; // Only buy txns

        const txQty = tx.assetQuantity ? new Decimal(tx.assetQuantity) : new Decimal(1);
        const txCost = new Decimal(tx.debit);

        runningQty = runningQty.plus(txQty);
        runningCost = runningCost.plus(txCost);

        records.push({
            assetId: portfolioItemId,
            tenantId,
            date: tx.transaction_date,
            value: runningCost.div(runningQty), // Weighted average per-unit price
            currency: tx.currency,
            notes: 'Auto-seeded from purchase transaction',
        });
    }

    if (records.length > 0) {
        await prisma.manualAssetValue.createMany({
            data: records,
            skipDuplicates: true,
        });
        logger.info(`[Sync] Auto-seeded ${records.length} ManualAssetValue records for portfolio item ${portfolioItemId}`);
    }

    return records.length;
};

const processPortfolioChanges = async (job) => {
    const { tenantId, transactionId, institutionId, accountIds, dateScopes, _rebuildMeta } = job.data;

    if (transactionId) {
        // --- Scoped Update Logic (single transaction) ---
        return await handleScopedUpdate(tenantId, transactionId, _rebuildMeta);
    } else if (accountIds && accountIds.length > 0) {
        // --- Account-scoped rebuild (e.g., after Plaid promote or import) ---
        return await handleFullRebuild(tenantId, institutionId, accountIds, dateScopes, _rebuildMeta);
    } else {
        // --- Full Rebuild Logic ---
        return await handleFullRebuild(tenantId, institutionId, undefined, undefined, _rebuildMeta);
    }
};

const handleScopedUpdate = async (tenantId, transactionId, _rebuildMeta) => {
    logger.info(`--- Starting Scoped Portfolio Update for tenant: ${tenantId}, transaction: ${transactionId} ---`);
    
    const transaction = await prisma.transaction.findUnique({
        where: { id: transactionId },
        include: { category: true, account: { select: { countryId: true } } },
    });

    if (!transaction) {
        logger.warn(`[Scoped] Transaction ${transactionId} not found. Skipping.`);
        return { success: false, message: 'Transaction not found' };
    }

    const affectedPortfolioItems = new Map();
    const dateScopes = new Set([`${transaction.year}-${transaction.month}`]);

    // 1. Handle the primary portfolio item (if any)
    const assetKey = generateAssetKey(transaction, decrypt);
    let portfolioItem = null;

    if (assetKey) {
        portfolioItem = await prisma.portfolioItem.findUnique({
            where: { tenantId_symbol: { tenantId, symbol: assetKey } },
        });

        // If item does not exist, apply origination rule before creating.
        if (!portfolioItem) {
            const itemType = transaction.category?.type;
            let isOrigination = false;
            if (itemType === 'Investments') {
                isOrigination = transaction.debit && new Decimal(transaction.debit).gt(0);
            } else if (itemType === 'Debt') {
                isOrigination = transaction.credit && new Decimal(transaction.credit).gt(0);
            }

            if (!isOrigination) {
                logger.warn(`[Scoped] Skipping creation for non-originating transaction for new symbol '${assetKey}'.`);
            } else {
                portfolioItem = await prisma.portfolioItem.create({
                    data: {
                        tenantId,
                        categoryId: transaction.categoryId,
                        symbol: assetKey,
                        currency: transaction.currency,
                        source: transaction.ticker ? 'SYNCED' : 'MANUAL',
                        ...(transaction.isin && { isin: transaction.isin }),
                        ...(transaction.exchange && { exchange: transaction.exchange }),
                        ...(transaction.assetCurrency && { assetCurrency: transaction.assetCurrency }),
                    },
                });
            }
        }
    }

    // If we have an item (either found or created), proceed with state update.
    if (portfolioItem) {
        // Link the transaction first to ensure it's included in the state calculation.
        await prisma.transaction.update({
            where: { id: transactionId },
            data: { portfolioItemId: portfolioItem.id },
        });

        // Re-fetch the item with its full transaction history to ensure correct state calculation.
        const itemWithFullHistory = await prisma.portfolioItem.findUnique({
            where: { id: portfolioItem.id },
            include: { transactions: { orderBy: { transaction_date: 'asc' }, include: { category: true } } },
        });

        // Recalculate and update the state based on the full history.
        const newState = await calculatePortfolioItemState(itemWithFullHistory.transactions);
        await prisma.portfolioItem.update({
            where: { id: portfolioItem.id },
            data: newState,
        });

        // Seed ManualAssetValue for MANUAL-source items (new or existing) on buy transactions.
        // Uses the full transaction history to calculate correct running weighted averages.
        if (portfolioItem.source === 'MANUAL' && transaction.debit && new Decimal(transaction.debit).gt(0)) {
            const buyTransactions = itemWithFullHistory.transactions
                .filter(tx => tx.debit && new Decimal(tx.debit).gt(0))
                .sort((a, b) => a.transaction_date - b.transaction_date);

            // Delete existing auto-seeded values and re-create with updated weighted averages.
            // User-created manual values (with different notes) are preserved.
            await prisma.manualAssetValue.deleteMany({
                where: {
                    assetId: portfolioItem.id,
                    notes: 'Auto-seeded from purchase transaction',
                },
            });
            await seedManualAssetValues(portfolioItem.id, tenantId, buyTransactions);
        }

        affectedPortfolioItems.set(portfolioItem.id, portfolioItem);
    }


    // 2. Handle the cash portfolio item
    const cashCategory = await prisma.category.findFirst({
        where: { tenantId, processingHint: 'CASH' },
    });
    if (cashCategory) {
        const cashSymbol = `Cash ${transaction.currency}`;
        const cashItem = await prisma.portfolioItem.upsert({
            where: { tenantId_symbol: { tenantId, symbol: cashSymbol } },
            update: {},
            create: {
                tenantId,
                categoryId: cashCategory.id,
                symbol: cashSymbol,
                currency: transaction.currency,
                source: 'SYSTEM',
            },
        });
        affectedPortfolioItems.set(cashItem.id, cashItem);
    }

    // 3. Emit completion event with the precise "blast radius"
    const payload = {
        tenantId,
        portfolioItemIds: Array.from(affectedPortfolioItems.keys()),
        dateScopes: Array.from(dateScopes).map(ds => {
            const [year, month] = ds.split('-');
            return {
                year: parseInt(year),
                month: parseInt(month),
                currency: transaction.currency,
                type: transaction.category?.type,
                group: transaction.category?.group,
                country: transaction.account?.countryId,
            };
        }),
    };
    
    // Forward `_rebuildMeta` so the admin-rebuild chain stays traceable
    // through cash → analytics → valuation and the terminal worker can
    // release the single-flight lock on completion.
    if (_rebuildMeta) payload._rebuildMeta = _rebuildMeta;
    await enqueueEvent('PORTFOLIO_CHANGES_PROCESSED', payload);
    logger.info(`[Scoped] Emitted PORTFOLIO_CHANGES_PROCESSED event.`, payload);

    return { success: true, affectedItemCount: affectedPortfolioItems.size };
};


const handleFullRebuild = async (tenantId, institutionId, accountIds, dateScopes, _rebuildMeta) => {
    const isAccountScoped = accountIds && accountIds.length > 0;
    const scope = isAccountScoped
        ? `accounts: [${accountIds.join(', ')}]`
        : institutionId ? `institution: ${institutionId}` : 'tenant';
    logger.info(`--- Starting Portfolio Rebuild for tenant: ${tenantId}, scope: ${scope} ---`);

    // Build scope filters based on what's provided
    const accountScopeFilter = isAccountScoped
        ? { accountId: { in: accountIds } }
        : institutionId ? { account: { bankId: institutionId } } : {};

    const portfolioItemWhereScope = {
        tenantId,
        ...(isAccountScoped && { transactions: { some: { accountId: { in: accountIds } } } }),
        ...(!isAccountScoped && institutionId && { transactions: { some: { account: { bankId: institutionId } } } }),
    };

    // --- Step 1: Pre-fetch all existing items in the current scope into a map ---
    logger.info(`[Sync] Fetching existing portfolio items in scope...`);
    const existingItems = await prisma.portfolioItem.findMany({
        where: portfolioItemWhereScope,
        select: { id: true, symbol: true },
    });
    const existingItemsMap = new Map(existingItems.map(item => [item.symbol, item]));
    logger.info(`[Sync] Found ${existingItemsMap.size} existing portfolio items in scope.`);

    // This set will track all symbols that are active (found or created) during this run.
    const activeSymbols = new Set();


    // --- Step 2: Fetch all relevant transactions ---
    const transactionWhereScope = {
        tenantId,
        category: { type: { in: ['Investments', 'Debt'] } },
        ...accountScopeFilter,
    };

    logger.info(`[Sync] Fetching all investment/debt transactions for scope...`);
    const allTransactions = await prisma.transaction.findMany({
        where: transactionWhereScope,
        include: { 
            category: true
        }
    });
    logger.info(`[Sync] ...fetched ${allTransactions.length} total transactions from DB.`);

    if (allTransactions.length === 0) {
        // If there are no transactions, all existing items in this scope are orphans.
        if (existingItems.length > 0) {
            const itemIdsToDelete = existingItems.map(item => item.id);
            logger.info(`[Sync] No transactions found. Pruning ${itemIdsToDelete.length} orphan items.`);
            await prisma.portfolioItem.deleteMany({ where: { id: { in: itemIdsToDelete } } });
        }
        logger.info(`[Sync] No investment or debt transactions found for scope: ${scope}. Nothing further to do.`);

        // Defense-in-depth: ensure cash portfolio items exist for ALL transaction currencies
        // in scope (e.g. Plaid pure-cash checking accounts that have no Investment/Debt
        // transactions — the code below would never be reached for those accounts).
        if (isAccountScoped) {
            const cashCategory = await prisma.category.findFirst({
                where: { tenantId, processingHint: 'CASH' }
            });
            if (cashCategory) {
                const currenciesInScope = await prisma.transaction.findMany({
                    where: { tenantId, ...accountScopeFilter },
                    select: { currency: true },
                    distinct: ['currency']
                });
                if (currenciesInScope.length > 0) {
                    logger.info(`[Sync] Upserting cash portfolio items for ${currenciesInScope.length} currencies in account-scoped early return.`);
                    await prisma.$transaction(
                        currenciesInScope.map(({ currency }) => prisma.portfolioItem.upsert({
                            where: { tenantId_symbol: { tenantId, symbol: `Cash ${currency}` } },
                            update: {},
                            create: {
                                tenantId,
                                categoryId: cashCategory.id,
                                symbol: `Cash ${currency}`,
                                currency,
                                source: 'SYSTEM',
                            },
                        }))
                    );
                }
            }
        }

        await enqueueEvent('PORTFOLIO_CHANGES_PROCESSED', {
            tenantId,
            isFullRebuild: !isAccountScoped,
            // For account-scoped updates, pass empty portfolioItemIds + dateScopes
            // so downstream cash/analytics processing still triggers
            ...(isAccountScoped && { portfolioItemIds: [], dateScopes: dateScopes || [] }),
            ...(_rebuildMeta ? { _rebuildMeta } : {}),
        });
        return { success: true, portfolioItemsCreated: 0 };
    }

    // --- Step 2a: Pre-fetch all currency rates for the entire transaction date range ---
    const currencyRateCache = new Map();
    const uniqueCurrenciesToFetch = [...new Set(allTransactions.filter(tx => tx.currency !== 'USD').map(tx => tx.currency))];
    if (uniqueCurrenciesToFetch.length > 0) {
        // Pass 1: Find min/max dates
        let earliestDate = new Date(allTransactions[0].transaction_date);
        let latestDate = new Date(allTransactions[0].transaction_date);
        for (const tx of allTransactions) {
            const txDate = new Date(tx.transaction_date);
            if (txDate < earliestDate) earliestDate = txDate;
            if (txDate > latestDate) latestDate = txDate;
        }

        // Pass 2: Fetch all rates in bulk
        for (const currency of uniqueCurrenciesToFetch) {
            logger.info(`[Sync] Pre-fetching all currency rates for ${currency} from ${earliestDate.toISOString().slice(0, 10)} to ${latestDate.toISOString().slice(0, 10)}...`);
            const ratesMap = await getRatesForDateRange(earliestDate, latestDate, currency, 'USD');
            for (const [dateStr, rate] of ratesMap.entries()) {
                const cacheKey = `${dateStr}_${currency}_USD`;
                currencyRateCache.set(cacheKey, rate);
            }
            logger.info(`[Sync] ...fetched and cached ${ratesMap.size} rates for ${currency}.`);
        }
    }


    // --- Step 2b: Ensure "Cash" Portfolio Items Exist ---
    const uniqueCurrencies = [...new Set(allTransactions.map(tx => tx.currency))];
    // Find the category configured for cash handling. This is more robust than using a hardcoded name.
    const cashCategory = await prisma.category.findFirst({
        where: { tenantId, processingHint: 'CASH' },
    });
    
    if (cashCategory && uniqueCurrencies.length > 0) {
        logger.info(`[Sync] Ensuring cash portfolio items exist for currencies: ${uniqueCurrencies.join(', ')}`);
        const cashItemUpserts = uniqueCurrencies.map(currency => {
            const symbol = `Cash ${currency}`;
            activeSymbols.add(symbol); // Ensure cash items are not pruned later.
            
            return prisma.portfolioItem.upsert({
                where: { tenantId_symbol: { tenantId, symbol } },
                update: {},
                create: {
                    tenantId,
                    categoryId: cashCategory.id,
                    symbol,
                    currency,
                    source: 'SYSTEM',
                },
            });
        });

        await prisma.$transaction(cashItemUpserts);
        logger.info(`[Sync] Finished upserting ${cashItemUpserts.length} cash portfolio items.`);
    }

    // --- Step 3: Group transactions and perform "upsert" logic ---
    const transactionsByGroup = allTransactions.reduce((acc, tx) => {
        const key = generateAssetKey(tx, decrypt);
        if (!key) return acc;

        if (!acc.has(key)) {
            acc.set(key, []);
        }
        acc.get(key).push(tx);
        return acc;
    }, new Map());

    let portfolioItemsToCreate = [];

    for (const [symbol, transactions] of transactionsByGroup.entries()) {
        // BullMQ lock heartbeat — see `utils/jobHeartbeat.js`. Safe
        // to call unconditionally (no-ops when not attached,
        // self rate-limits to ~60s intervals).
        await job.heartbeat?.();
        // --- Start Change: Sort transactions immediately to avoid side-effects ---
        transactions.sort((a, b) => a.transaction_date - b.transaction_date);
        // --- End Change ---

        activeSymbols.add(symbol); // Mark this symbol as active for this run.

        // If the item already exists in our scope, we don't need to do anything with it here.
        // The transaction linking will handle it.
        if (existingItemsMap.has(symbol)) {
            continue;
        }
        
        // **Origination Transaction Rule**
        // Only create a new portfolio item if there is at least one "buy" (for investments)
        // or "origination" (for debt) transaction in the group.
        const firstTx = transactions[0];
        const itemType = firstTx.category?.type;
        let hasOriginationTransaction = false;
        if (itemType === 'Investments') {
            hasOriginationTransaction = transactions.some(tx => tx.debit && new Decimal(tx.debit).gt(0));
        } else if (itemType === 'Debt') {
            hasOriginationTransaction = transactions.some(tx => tx.credit && new Decimal(tx.credit).gt(0));
        }

        if (!hasOriginationTransaction) {
            logger.warn(`[Sync] Skipping creation of new portfolio item for symbol '${symbol}' because it has no originating transaction.`);
            activeSymbols.delete(symbol); // Un-mark as active if we aren't creating it.
            continue;
        }
        
        // --- Start Change: Calculate initial state using the new centralized utility ---
        const initialState = await calculatePortfolioItemState(transactions, currencyRateCache);
        // --- End Change ---
        
        const newItemData = {
            tenantId,
            categoryId: firstTx.categoryId,
            symbol: symbol,
            currency: firstTx.currency,
            source: firstTx.ticker ? 'SYNCED' : 'MANUAL',
            ...(firstTx.isin && { isin: firstTx.isin }),
            ...(firstTx.exchange && { exchange: firstTx.exchange }),
            ...(firstTx.assetCurrency && { assetCurrency: firstTx.assetCurrency }),
            createdAt: new Date(),
            updatedAt: new Date(),
            ...initialState, // Spread the calculated state
        };
        
        portfolioItemsToCreate.push(newItemData);
    }
    
    // --- Step 4: Bulk create any new items ---
    if (portfolioItemsToCreate.length > 0) {
        logger.info(`[Sync] Preparing to create ${portfolioItemsToCreate.length} items. Data:`, JSON.stringify(portfolioItemsToCreate, null, 2));
        await prisma.portfolioItem.createMany({
            data: portfolioItemsToCreate,
            skipDuplicates: true
        });
        logger.info(`[Sync] Bulk created ${portfolioItemsToCreate.length} new portfolio items.`);
    }

    // --- Step 5: Link all transactions to their portfolio items ---
    // Refetch all items for the tenant to get the IDs of newly created ones
    const allPortfolioItemsForTenant = await prisma.portfolioItem.findMany({
        where: { tenantId },
        select: { id: true, symbol: true }
    });
    const allItemsMap = new Map(allPortfolioItemsForTenant.map(item => [item.symbol, item]));

    // --- Step 5b: Seed ManualAssetValue for newly created MANUAL-source items ---
    for (const itemData of portfolioItemsToCreate) {
        await job.heartbeat?.();
        if (itemData.source !== 'MANUAL') continue;

        const portfolioItem = allItemsMap.get(itemData.symbol);
        if (!portfolioItem) continue;

        const transactions = transactionsByGroup.get(itemData.symbol) || [];
        await seedManualAssetValues(portfolioItem.id, tenantId, transactions);
    }

    const transactionUpdates = [];
    for (const tx of allTransactions) {
        const symbol = generateAssetKey(tx, decrypt);
        const portfolioItem = allItemsMap.get(symbol);
        if (portfolioItem && tx.portfolioItemId !== portfolioItem.id) {
            transactionUpdates.push(
                prisma.transaction.update({
                    where: { id: tx.id },
                    data: { portfolioItemId: portfolioItem.id }
                })
            );
        }
    }

    if (transactionUpdates.length > 0) {
        await prisma.$transaction(transactionUpdates);
        logger.info(`[Sync] Bulk linked/updated ${transactionUpdates.length} transactions.`);
    }

    // --- Step 6: Prune any orphan items that are no longer active ---
    const itemsToDelete = [];
    for (const [symbol, item] of existingItemsMap.entries()) {
        if (!activeSymbols.has(symbol)) {
            itemsToDelete.push(item.id);
        }
    }

    if (itemsToDelete.length > 0) {
        logger.info(`[Sync] Pruning ${itemsToDelete.length} orphan portfolio items.`);
        await prisma.portfolioItem.deleteMany({
            where: {
                id: { in: itemsToDelete }
            }
        });
    }

    logger.info(`--- Finished Portfolio Rebuild for tenant: ${tenantId}. ---`);

    // --- Step 7: Announce completion via an event ---
    // When account-scoped, emit with the affected portfolio item IDs + date scopes
    // so downstream analytics can process only the affected data.
    // Use allItemsMap (fetched after bulk-create in Step 5) so newly created items are included.
    const allAffectedItemIds = [...activeSymbols]
        .map((sym) => allItemsMap.get(sym)?.id)
        .filter(Boolean);

    await enqueueEvent('PORTFOLIO_CHANGES_PROCESSED', {
        tenantId,
        isFullRebuild: !isAccountScoped,
        institutionId,
        ...(isAccountScoped && allAffectedItemIds.length > 0 && { portfolioItemIds: allAffectedItemIds }),
        ...(isAccountScoped && dateScopes && { dateScopes }),
        ...(_rebuildMeta ? { _rebuildMeta } : {}),
    });
    logger.info(`[Sync] Emitted PORTFOLIO_CHANGES_PROCESSED event for tenant: ${tenantId}, isFullRebuild: ${!isAccountScoped}.`);

    return { success: true, portfolioItemsCreated: portfolioItemsToCreate.length };
}

module.exports = processPortfolioChanges;
