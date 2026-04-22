# Choosing Your External Services

Bliss works out of the box with just a database, but several external integrations unlock key features. **An LLM provider is required** for AI classification and financial insights — the rest are optional.

---

## LLM provider (REQUIRED)

**What it powers:** Transaction classification (Tier 4 of the waterfall) and financial insights.

Bliss needs an LLM to do two things it cannot work without: classify transactions it has never seen before, and generate the financial insights that show up on your dashboard. Without one of the three supported providers configured, new merchants stay unclassified until you review them by hand, and the insights page stays empty.

### Supported providers

| Provider | Embeddings | Classification | Insights | Notes |
|---|---|---|---|---|
| **Google Gemini** | `gemini-embedding-001` (3072-dim native, projected to 768) | `gemini-3-flash-preview` | `gemini-3.1-pro-preview` | Recommended for new installs. Native embedding support keeps setup to a single key. |
| **OpenAI** | `text-embedding-3-small` (1536-dim native, projected to 768) | `gpt-4.1-mini` | `gpt-4.1` | Native embedding support. Good fit if you already have OpenAI billing set up. |
| **Anthropic Claude** | *(no embedding API)* | `claude-sonnet-4-6` | `claude-sonnet-4-6` | Best prose quality for insights, but requires a second provider for embeddings. |

All three providers produce 768-dimensional embeddings and return classifications in the same JSON shape. Switching providers does not change any API contracts or database schema.

### Quick decision guide

Pick **Gemini** if:
- You want the simplest setup (one key, one provider, done).
- You are running Bliss on a free tier and want the most generous free quota.

Pick **OpenAI** if:
- You already have an OpenAI account and billing you trust.
- You prefer OpenAI's classification behavior.

Pick **Anthropic Claude** if:
- You want the highest-quality prose for monthly, quarterly, and annual insight reports.
- You are comfortable configuring a second provider for embeddings.

### Configuration

All configuration happens in `.env`. There are no per-tenant settings and no database migrations involved.

**Gemini (default)**
```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
```

**OpenAI**
```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

**Anthropic Claude**

Anthropic does not expose an embedding API. You must configure a secondary provider (Gemini or OpenAI) for embeddings:
```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

If you forget to set `EMBEDDING_PROVIDER`, Bliss fails loudly at startup with a clear error message. The app will not run in a broken state.

### Model overrides

Each slot has a sensible default, but you can override any of them:

```env
EMBEDDING_MODEL=text-embedding-3-large
CLASSIFICATION_MODEL=gpt-4.1
INSIGHT_MODEL=gpt-4.1
```

Model overrides are honored by whichever adapter is active. Omit them unless you need to pin a specific model version.

### Interactive setup

The `./scripts/setup.sh` script prompts you for an LLM provider as part of the first-run flow, before it generates your secrets. If you pick Anthropic it follows up with an embedding-provider prompt. The chosen provider and key(s) are written into `.env` automatically.

If you already have a `.env` and want to switch providers, edit the file directly — `setup.sh` will not overwrite an existing `.env`.

### Switching providers later

Switching is safe and reversible. The exact steps depend on what you're changing.

**Changing only the classification / insights provider**

For example, moving from Gemini to Anthropic while keeping Gemini for embeddings:

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
EMBEDDING_PROVIDER=gemini
# GEMINI_API_KEY is already set
```

Restart the `api` and `backend` services. New classifications and insights use the new provider immediately. Existing embeddings stay valid because the embedding provider didn't change.

**Changing the embedding provider**

Vectors from one provider aren't comparable with vectors from another — even at the same dimensionality. When you switch `EMBEDDING_PROVIDER`, the stored embeddings become stale and Tier 2/3 vector search starts returning nonsense until the index is rebuilt.

The workflow mirrors encryption key rotation:

1. Update `.env` with the new `EMBEDDING_PROVIDER` (and its API key).
2. Restart `api` and `backend`.
3. Run the re-embed script:

```bash
# Dry run first — counts rows without calling the API
node scripts/regenerate-embeddings.js --dry-run

# Full rebuild
node scripts/regenerate-embeddings.js

# One tenant at a time
node scripts/regenerate-embeddings.js --tenant=<tenantId>
```

The script is idempotent — safe to re-run after a crash.

### Graceful degradation

If the LLM provider's API key is unset or invalid:

- **Tier 1 (exact match) still works.** Every merchant you have already classified is recognized instantly.
- **Tier 2/3 (vector search) is disabled** for embedding failures — new unseen merchants cannot be matched semantically.
- **Tier 4 (LLM) is disabled.** Unseen merchants remain unclassified until you review them manually.
- **Insights are unavailable.** The insights page stays empty.

No data is lost, and the rest of the app (transactions, portfolio, analytics) continues working normally.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `LLM_PROVIDER=anthropic requires EMBEDDING_PROVIDER to be set explicitly` | You set Anthropic but didn't configure a secondary embedding provider | Add `EMBEDDING_PROVIDER=gemini` (or `openai`) plus the matching API key |
| `EMBEDDING_PROVIDER cannot be anthropic` | Tried to use Anthropic for embeddings | Use Gemini or OpenAI for this slot |
| Vector search returns bad matches after switching providers | Changed `EMBEDDING_PROVIDER` but didn't rebuild the index | Run `node scripts/regenerate-embeddings.js` |
| Rate-limit errors in logs | Hit provider quota | Adapters retry with minute-scale backoff automatically. If persistent, upgrade plan or lower `PHASE2_CONCURRENCY` in `apps/backend/src/config/classificationConfig.js` |

**Env vars (summary):** `LLM_PROVIDER`, `EMBEDDING_PROVIDER`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, plus optional `EMBEDDING_MODEL` / `CLASSIFICATION_MODEL` / `INSIGHT_MODEL`.

For the full technical details of the adapter layer, see [Backend Spec 20 — LLM Provider Abstraction](/docs/specifications).

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
