# Choosing Your External Services

Bliss works out of the box with just a database, but several external integrations unlock key features. **An LLM provider is required** for AI classification and financial insights — the rest are optional.

---

## LLM Provider (REQUIRED)

**What it powers:** Transaction classification (Tier 4 of the AI waterfall) and financial insights.

Bliss uses a large language model in two ways: to categorize new, unseen transactions that don't match your existing history, and to write the monthly, quarterly, annual, and portfolio insight reports on your dashboard. Bring your own provider — pick one of three.

| Provider | Native embeddings | Notes |
|---|---|---|
| **Google Gemini** | ✅ | Recommended default. Generous free tier, one key covers everything. |
| **OpenAI** | ✅ | Good fit if you already have OpenAI billing. |
| **Anthropic Claude** | ❌ | Best prose quality for insights. Requires a second provider (Gemini or OpenAI) for embeddings, since Anthropic does not offer an embedding API. |

**Plan recommendations:**
- **Gemini free tier** — Enough for a single-user setup with CSV imports. No billing needed to get started.
- **OpenAI pay-as-you-go** — Typical monthly cost is cents to low single-digit dollars for an active user, dominated by insights (embeddings + classifications are very cheap).
- **Anthropic Claude Sonnet** — Slightly pricier per token than the others, but users consistently rate the insight narratives as the most natural to read.

**Setup:** `./scripts/setup.sh` prompts you to choose a provider and paste its API key on first run. If you pick Anthropic it also prompts for an embedding provider. Done.

**Switching providers later:** Safe and reversible. Edit `.env` and restart. If you change the embedding provider specifically, you also run `scripts/regenerate-embeddings.js` once to rebuild the vector index. See [Backend Spec 20 — LLM Provider Abstraction](/docs/specifications) for the full workflow.

**Without an LLM:** Transactions you've already categorized still auto-match on sight (Tier 1 cache). But new merchants stay unclassified until you review them, and the insights page is empty. The rest of Bliss — transactions, portfolio, analytics, Plaid sync — keeps working normally.

**Env vars:** `LLM_PROVIDER`, API key for the selected provider (`GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`), plus `EMBEDDING_PROVIDER` + its key when using Anthropic.

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
| LLM provider (Gemini / OpenAI / Anthropic) | AI classification + insights | **Yes** | Free tiers available from all three |
| Twelve Data | Stock/ETF/crypto prices | No | Free tier for basics; Pro for international |
| Plaid | Bank account sync | No | Free sandbox for testing |
| CurrencyLayer | Exchange rates | No | Free tier available |

The optional services degrade gracefully. The LLM provider is the one hard requirement — without it, AI classification and insights are unavailable.

---

## Next steps

- [Initial Account Setup](/docs/guides/tenant-seed-setup) -- set up your accounts and categories
- [Importing Transactions](/docs/guides/importing-transactions) -- bring in your history via CSV
- [AI Classification](/docs/guides/ai-classification) -- learn how the classification pipeline works
- [Financial Insights](/docs/guides/financial-insights) -- what the insights engine does with your data
