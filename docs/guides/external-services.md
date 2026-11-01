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

## Twelve Data (Market Prices + FX Rates)

**What it powers:** Real-time and historical pricing for stocks, ETFs, mutual funds, and cryptocurrencies — **and, by default, historical & current foreign-exchange (FX) rates** for multi-currency portfolios.

Bliss uses Twelve Data to:
- Fetch current prices for portfolio valuation
- Look up historical prices for cost basis and P&L calculations
- Search for ticker symbols when adding investment transactions
- Retrieve company fundamentals (earnings, dividends, P/E ratio) for equity analysis
- Resolve currency-pair exchange rates (e.g. `EUR/USD`) for portfolio, analytics, and transaction-display conversion — the same key covers both equities and FX

Twelve Data covers 10,000+ symbols across 27+ global markets (NYSE, NASDAQ, XETRA, Euronext, LSE, Borsa Italiana, and more).

**Cost optimization:** Bliss caches all fetched prices in the database. Once a price is retrieved for a given date/symbol, it's never fetched again. The nightly SecurityMaster refresh also stores fundamentals locally. This means your API usage stays low after the initial historical backfill.

**Plan recommendations:**
- **Basic** -- Sufficient if you only track US-listed stocks and don't need real-time quotes. Covers NYSE and NASDAQ.
- **Pro (recommended)** -- Unlocks international exchanges (European, Asian, Australian markets), real-time pricing, and higher rate limits. Best fit for users with a global portfolio.

**Without Twelve Data:** Portfolio items still track quantities and lots, but prices show as stale or unavailable. Manual valuations can be entered as a fallback. FX rates fall back to manual entry too (or to CurrencyLayer if you set `CURRENCY_PROVIDER=CURRENCYLAYER`).

**Env vars:** `TWELVE_DATA_API_KEY`, plus `CURRENCY_PROVIDER` (default `TWELVE_DATA`) for FX. See *Currency / FX Rates* below.

---

## Bank Sync: Plaid or Enable Banking

Bliss has two bank feeds. Both land transactions in the same **Transaction Review** queue, with the same AI classification and duplicate detection. Pick by where your bank is; you can run both side by side.

| | Plaid | Enable Banking |
|---|---|---|
| **Banks** | US, Canada, UK | EU banks over PSD2 (Revolut ES tested first) |
| **Who sets it up** | The server operator (env vars) | Each workspace admin, in the app (no env vars) |
| **Credentials** | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Your own Enable Banking application: app ID + private key in **Settings → Bank sync** or during onboarding |
| **Limits** | Your Plaid plan | 5 linked accounts per application in restricted mode |
| **History** | Up to 2 years on first connect | Booked transactions from your history-days setting; the consent lasts as long as the bank allows (180 days for Revolut ES) and Bliss reminds you to renew it |

**Choose Plaid** when your banks are in the US, Canada or the UK. Plaid serves EU banks only on Custom plans.

**Choose Enable Banking** when your banks are in the EU. Nothing changes on the server: a workspace admin brings an Enable Banking application and connects the first bank from the onboarding wizard or Settings → Bank sync.

The first-run wizard shows both options side by side. When the server has no Plaid keys, the Plaid option says so instead of showing a button.

### Plaid

**What it powers:** Automatic bank account linking and transaction synchronization.

Plaid connects to thousands of financial institutions worldwide. Once linked, Bliss:
- Pulls your full transaction history (configurable depth, up to 2 years)
- Syncs new transactions automatically via incremental cursor-based updates
- Detects investment transactions and enriches them with ticker/price data
- Monitors connection health and handles re-authentication when banks require it

**Without Plaid:** You can still use Enable Banking for EU banks, or import transactions via CSV/XLSX. The Smart Import pipeline provides the same AI classification -- the only difference is that you export from your bank and upload the file yourself.

**Env vars:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`

See the [Bank Sync with Plaid](/docs/guides/plaid-bank-sync) guide for setup details.

### Enable Banking (EU)

**What it powers:** EU bank connections through PSD2 consent, feeding the same review queue as Plaid.

Each workspace connects through its own Enable Banking application, so there is nothing to configure on the server. A workspace admin enters the application ID and private key once (during onboarding or in **Settings → Bank sync**); Bliss verifies them with Enable Banking, stores them encrypted and never shows the key again. The bank's consent page then authorizes access, and Bliss reminds you before the consent expires.

**Env vars:** none required. Optional server-wide settings: `ENABLE_BANKING_REDIRECT_URL`, `ENABLE_BANKING_SYNC_TIMES`, `ENABLE_BANKING_DAILY_BUDGET`.

See the [EU Bank Sync with Enable Banking](/docs/guides/enable-banking) guide for setup details.

---

## Currency / FX Rates

**What it powers:** Automatic historical and current exchange-rate fetching for multi-currency P&L and portfolio valuation.

When your accounts span multiple currencies, Bliss needs exchange rates to normalize everything to your display currency. These rates are used by:
- Portfolio processing (converting foreign-currency investments to your portfolio currency)
- Analytics (aggregating spending across currencies into a single P&L)
- Transaction display (showing amounts in your preferred currency)

**Provider:** Controlled by `CURRENCY_PROVIDER`:

| Value | Source | Notes |
|---|---|---|
| `TWELVE_DATA` (default) | Twelve Data forex endpoints | Reuses `TWELVE_DATA_API_KEY` — **no separate subscription**. Recommended for all new installs. |
| `CURRENCYLAYER` | [CurrencyLayer](https://currencylayer.com/) | Legacy. Requires `CURRENCYLAYER_API_KEY`. Kept for reversibility and existing instances. |

When `CURRENCY_PROVIDER` is unset, Bliss picks Twelve Data if `TWELVE_DATA_API_KEY` is set, otherwise CurrencyLayer if `CURRENCYLAYER_API_KEY` is set, otherwise Twelve Data with auto-fetch disabled until a key is added.

**Cost optimization:** Like market prices, exchange rates are cached in the database after the first fetch. A rate for USD/EUR on 2024-03-15 is stored permanently and never re-fetched — switching providers does not re-fetch or rewrite existing rows.

**Pair coverage:** Twelve Data covers all mainstream currency pairs as forex symbols (`FROM/TO`), and Bliss automatically retries the inverse pair when needed. A pair Twelve Data does not list as a forex symbol (rare — some exotic or pegged currencies) falls back to manual entry through the UI.

**Without an FX provider key:** You can enter exchange rates manually through the UI. This works fine for a single currency or a handful of rates, but becomes tedious for active multi-currency use.

**Env vars:** `CURRENCY_PROVIDER` (default `TWELVE_DATA`), `TWELVE_DATA_API_KEY` (for the default path), `CURRENCYLAYER_API_KEY` (legacy path only).

---

## Summary

| Service | Feature | Required? | Cost impact |
|---------|---------|-----------|-------------|
| LLM provider (Gemini / OpenAI / Anthropic) | AI classification + insights | **Yes** | Free tiers available from all three |
| Twelve Data | Stock/ETF/crypto prices **+ FX rates (default)** | No | Free tier for basics; Pro for international |
| Plaid | Bank account sync (US, CA, UK) | No | Free sandbox for testing |
| Enable Banking | Bank account sync (EU, PSD2) — no env vars, per-workspace credentials | No | Free restricted-mode application (5 accounts) |
| CurrencyLayer | Exchange rates (legacy — only when `CURRENCY_PROVIDER=CURRENCYLAYER`) | No | Not needed if Twelve Data is configured |

The optional services degrade gracefully. The LLM provider is the one hard requirement — without it, AI classification and insights are unavailable.

---

## Next steps

- [Initial Account Setup](/docs/guides/tenant-seed-setup) -- set up your accounts and categories
- [Importing Transactions](/docs/guides/importing-transactions) -- bring in your history via CSV
- [AI Classification](/docs/guides/ai-classification) -- learn how the classification pipeline works
- [Financial Insights](/docs/guides/financial-insights) -- what the insights engine does with your data
