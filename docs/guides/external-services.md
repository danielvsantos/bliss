# Choosing Your External Services

Bliss works out of the box with just a database, but connecting external services unlocks its most powerful features. This guide explains what each integration does, why you might want it, and what it costs.

All integrations are optional. The app detects which API keys are present and enables features accordingly.

---

## Google Gemini (AI)

**What it powers:** Transaction classification and financial insights.

Gemini is used in two ways:

1. **Classification (Gemini Flash)** -- When a transaction can't be matched by the in-memory cache or vector similarity search, Gemini classifies it using your existing categories as context. It also generates the 768-dimensional embeddings that power the vector similarity tier.

2. **Financial Insights (Gemini Pro)** -- Analyzes your spending patterns, portfolio exposure, income stability, and more to generate actionable insights across 7 financial lenses.

**Without Gemini:** Tier 1 (exact match) still works -- once you manually classify a transaction, the same merchant is auto-classified forever. But new, unseen merchants will remain unclassified until you review them. Insights are unavailable.

**Env var:** `GEMINI_API_KEY`

---

## Twelve Data (Market Prices)

**What it powers:** Real-time and historical pricing for stocks, ETFs, mutual funds, and cryptocurrencies.

Bliss uses Twelve Data to:
- Fetch current prices for portfolio valuation
- Look up historical prices for cost basis and P&L calculations
- Search for ticker symbols when adding investment transactions
- Retrieve company fundamentals (earnings, dividends, P/E ratio) for equity analysis

Twelve Data covers 10,000+ symbols across 27+ global markets (NYSE, NASDAQ, XETRA, Euronext, LSE, Borsa Italiana, and more).

**Cost optimization:** Bliss caches all fetched prices in the database. Once a price is retrieved for a given date/symbol, it's never fetched again. The nightly SecurityMaster refresh also stores fundamentals locally. This means your API usage stays low after the initial historical backfill.

**Plan recommendations:**
- **Basic** -- Sufficient if you only track US-listed stocks and don't need real-time quotes. Covers NYSE and NASDAQ.
- **Pro (recommended)** -- Unlocks international exchanges (European, Asian, Australian markets), real-time pricing, and higher rate limits. Best fit for users with a global portfolio.

**Without Twelve Data:** Portfolio items still track quantities and lots, but prices show as stale or unavailable. Manual valuations can be entered as a fallback.

**Env var:** `TWELVE_DATA_API_KEY`

---

## Plaid (Bank Sync)

**What it powers:** Automatic bank account linking and transaction synchronization.

Plaid connects to thousands of financial institutions worldwide. Once linked, Bliss:
- Pulls your full transaction history (configurable depth, up to 2 years)
- Syncs new transactions automatically via incremental cursor-based updates
- Detects investment transactions and enriches them with ticker/price data
- Monitors connection health and handles re-authentication when banks require it

**Without Plaid:** You can still import transactions manually via CSV/XLSX. The Smart Import pipeline provides the same AI classification -- the only difference is that you export from your bank and upload the file yourself.

**Env vars:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`

See the [Bank Sync with Plaid](/docs/guides/plaid-bank-sync) guide for setup details.

---

## CurrencyLayer (Exchange Rates)

**What it powers:** Automatic historical exchange rate fetching for multi-currency P&L and portfolio valuation.

When your accounts span multiple currencies, Bliss needs exchange rates to normalize everything to your display currency. CurrencyLayer provides historical rates used by:
- Portfolio processing (converting foreign-currency investments to your portfolio currency)
- Analytics (aggregating spending across currencies into a single P&L)
- Transaction display (showing amounts in your preferred currency)

**Cost optimization:** Like market prices, exchange rates are cached in the database after the first fetch. A rate for USD/EUR on 2024-03-15 is stored permanently and never re-fetched.

**Without CurrencyLayer:** You can enter exchange rates manually through the UI. This works fine if you have a single currency or only need a handful of rates, but becomes tedious for active multi-currency use.

**Env var:** `CURRENCYLAYER_API_KEY`

---

## Summary

| Service | Feature | Required? | Cost impact |
|---------|---------|-----------|-------------|
| Gemini | AI classification + insights | No | Free tier available |
| Twelve Data | Stock/ETF/crypto prices | No | Free tier for basics; Pro for international |
| Plaid | Bank account sync | No | Free sandbox for testing |
| CurrencyLayer | Exchange rates | No | Free tier available |

All services degrade gracefully. Start with none, add them as you need them, and Bliss adjusts automatically.

---

## Next steps

- [Initial Account Setup](/docs/guides/tenant-seed-setup) -- set up your accounts and categories
- [Importing Transactions](/docs/guides/importing-transactions) -- bring in your history via CSV
- [AI Classification](/docs/guides/ai-classification) -- learn how the classification pipeline works
