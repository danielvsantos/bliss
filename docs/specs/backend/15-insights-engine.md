# 15. Insights Engine (Backend)

The Insights Engine generates AI-powered financial insights for each tenant on a daily schedule. It is the first cron-based job in the system, analyzing 7 financial lenses via Google Gemini and storing results with SHA-256 data hash deduplication to avoid regenerating insights when underlying data hasn't changed.

---

## 15.1. Overview

The engine follows a three-stage pipeline:

1. **Data Gathering** — Queries analytics, portfolio, and debt data for the past 6 months, converting all monetary values to the tenant's portfolio currency.
2. **LLM Generation** — Builds a structured prompt with derived metrics and sends it to Gemini for analysis across 7 financial lenses.
3. **Storage** — Validates, deduplicates (via SHA-256 hash), and persists insights in a single atomic transaction.

Two trigger modes:
- **Daily cron** (`generate-all-insights`) — Iterates all tenants with transactions at 6 AM UTC.
- **On-demand** (`generate-tenant-insights`) — Triggered by the finance-api via `POST /api/insights/generate`.

---

## 15.2. Architecture

```
POST /api/insights/generate ──┐
                               ▼
                        insightQueue.js
                               │
                  ┌────────────┴────────────┐
                  │                         │
     generate-tenant-insights    generate-all-insights
                  │                    (daily cron)
                  │                         │
                  ▼                         ▼
        insightGeneratorWorker.js ──► iterates all tenants
                  │
                  ▼
          insightService.js
          ├── gatherTenantData()     → DB queries + currency conversion
          ├── buildInsightPrompt()   → system prompt + data JSON
          └── generateInsights()     → orchestration + storage
                  │
                  ▼
          geminiService.js
          └── generateInsightContent() → Gemini LLM call
                  │
                  ▼
            Insight table
```

### Key Files

| File | Purpose |
|------|---------|
| `src/queues/insightQueue.js` | BullMQ queue singleton (`insights`) |
| `src/workers/insightGeneratorWorker.js` | Worker: processes jobs, registers daily cron |
| `src/services/insightService.js` | Data gathering, metric derivation, prompt construction, storage |
| `src/services/geminiService.js` | `generateInsightContent()` — Gemini LLM call with retry |
| `src/routes/insights.js` | `POST /api/insights/generate` — internal trigger endpoint |

---

## 15.3. Data Gathering (`gatherTenantData`)

The `gatherTenantData(tenantId)` function in `insightService.js` queries three data sources and derives metrics from them. All monetary values are converted to the tenant's portfolio currency before being passed to the LLM.

### Data Sources

| Source | Query | Purpose |
|--------|-------|---------|
| `AnalyticsCacheMonthly` | Last 6 months, filtered by `currency: portfolioCurrency` | Spending, income, savings |
| `PortfolioItem` | All items with category + debtTerms | Investment exposure, debt health |
| `PortfolioValueHistory` | Last 6 months, joined through `asset.tenantId` | Net worth trajectory |

### Currency Conversion

Analytics data is pre-filtered by `currency: portfolioCurrency` — no conversion needed. Portfolio items and net worth history are converted using `currencyService.getOrCreateCurrencyRate()` with an in-memory `rateCache` scoped to the job run:

```javascript
async function convertAmount(amount, fromCurrency, toCurrency, date, rateCache) {
  if (!fromCurrency || fromCurrency === toCurrency || amount === 0) return amount;
  const rate = await getOrCreateCurrencyRate(date, fromCurrency, toCurrency, rateCache);
  if (!rate) return amount;
  return Number(rate) * amount;
}
```

- **Portfolio items**: Each item's `currentValue` is converted from `item.currency` to `portfolioCurrency`.
- **Debt items**: Both `balance` and `minimumPayment` are converted.
- **Net worth history**: Each data point's `valueInUSD` is converted from USD to `portfolioCurrency` using the data point's date for the exchange rate.

### Derived Metrics

| Metric | Derivation |
|--------|-----------|
| `spendingVelocity` | Month-over-month % change by category group (last 2 months) |
| `categoryConcentration` | Each group's % of total expenses in the current month |
| `incomeHistory` | 6-month income series (sorted chronologically) |
| `savingsHistory` | 6-month savings rate series: `(income - expenses) / income * 100` |
| `portfolioExposure` | Each investment's value and % of total investment portfolio |
| `debtHealth` | Each debt's converted balance, interest rate, and minimum payment |
| `netWorthHistory` | Daily portfolio values converted to portfolio currency |

### Return Shape

```javascript
{
  portfolioCurrency, months, monthlyData,
  spendingVelocity, categoryConcentration,
  incomeHistory, savingsHistory,
  portfolioExposure, debtHealth, netWorthHistory,
  totalInvestmentValue, totalDebt,
  hasTransactions, hasPortfolio, hasDebt
}
```

---

## 15.4. Lens Definitions

Each lens represents a financial perspective the LLM analyzes. Lenses are filtered based on data availability before the prompt is built.

| Lens | Data Source | Availability Condition |
|------|-------------|----------------------|
| `SPENDING_VELOCITY` | `AnalyticsCacheMonthly` | `hasTransactions` |
| `CATEGORY_CONCENTRATION` | `AnalyticsCacheMonthly` | `hasTransactions` |
| `INCOME_STABILITY` | `AnalyticsCacheMonthly` | `hasTransactions` |
| `SAVINGS_RATE` | `AnalyticsCacheMonthly` | `hasTransactions` |
| `PORTFOLIO_EXPOSURE` | `PortfolioItem` (Investments) | `portfolioExposure.length > 0` |
| `DEBT_HEALTH` | `PortfolioItem` (Debt) + `DebtTerms` | `hasDebt` |
| `NET_WORTH_TRAJECTORY` | `PortfolioValueHistory` | `netWorthHistory.length > 0` |

The LLM produces **exactly one insight per active lens**.

---

## 15.5. LLM Prompt Construction

### System Prompt

A template string with `{{CURRENCY}}` and `{{SYMBOL}}` placeholders, replaced at runtime via `getSystemPrompt(portfolioCurrency)`.

**Voice rules**:
- Write as a sophisticated financial concierge
- No exclamation points, no preamble
- Open with the observation itself
- Use precise numbers (e.g., "rose 23% to $847")
- One short paragraph per insight (2-4 sentences)
- Never give explicit financial advice

**Severity guide**:

| Severity | Meaning |
|----------|---------|
| `POSITIVE` | Favorable trend (savings up, debt declining) |
| `INFO` | Neutral observation worth noting |
| `WARNING` | Deserving attention (single category >40% of spend) |
| `CRITICAL` | Could cause financial stress if unchecked |

**Minimum data rules**: If a lens has <2 months of data, produce a single INFO "Not enough data yet" insight with priority 10.

### Currency Symbol Map

```javascript
const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', BRL: 'R$', JPY: '¥', CNY: '¥',
  AUD: 'A$', CAD: 'C$', CHF: 'CHF', INR: '₹', KRW: '₩', MXN: 'MX$',
};
```

### Prompt Structure

`buildInsightPrompt(tenantData, activeLenses)` concatenates:
1. System prompt (with currency/symbol substituted)
2. Active lenses list
3. Financial data as formatted JSON

---

## 15.6. Gemini Integration

`generateInsightContent(prompt)` in `geminiService.js` handles the LLM call.

| Setting | Value |
|---------|-------|
| Model | Configurable via `INSIGHT_MODEL` env var (default: `gemini-3.1-pro-preview`) |
| `responseMimeType` | `application/json` |
| Temperature | `0.4` (slightly creative for prose, but grounded) |
| Timeout | `60_000ms` (vs 30s for classification — insight prompts are larger) |
| Retries | `MAX_RETRIES = 5` |
| Backoff | Exponential (`1s, 2s, 4s`) for general errors; linear (`60s, 120s, 180s`) for rate-limit errors |

Rate-limit detection via `isRateLimitError()` — checks for `429`, `quota`, `resource has been exhausted`, `rate limit` in error messages.

---

## 15.7. Data Hash & Deduplication

Before calling the LLM, a SHA-256 hash is computed from the derived metrics:

```javascript
const hashInput = JSON.stringify({
  m: tenantData.monthlyData,
  sv: tenantData.spendingVelocity,
  cc: tenantData.categoryConcentration,
  pe: tenantData.portfolioExposure,
  dh: tenantData.debtHealth,
  nw: tenantData.netWorthHistory,
});
const dataHash = crypto.createHash('sha256').update(hashInput).digest('hex');
```

The hash is compared against the latest batch's `dataHash` in the database. If unchanged, generation is skipped entirely — saving LLM costs and avoiding duplicate insights.

---

## 15.8. Worker & Queue

### Queue: `insightQueue.js`

| Setting | Value |
|---------|-------|
| Queue name | `insights` |
| Pattern | Singleton (lazy-initialized on first `getInsightQueue()` call) |
| Default attempts | 3 |
| Backoff | Exponential, 2s base |
| Retention | Completed: 24h or 500 jobs; Failed: 7 days |

### Worker: `insightGeneratorWorker.js`

| Setting | Value |
|---------|-------|
| Concurrency | `1` (serial processing — prevents LLM rate limit contention) |
| Lock duration | `600_000ms` (10 minutes — LLM calls can be slow) |

### Daily Cron

Registered at worker startup:

```javascript
getInsightQueue().add('generate-all-insights', {}, {
  repeat: { pattern: '0 6 * * *' },  // Daily at 6 AM UTC
  jobId: 'daily-insight-generation',
});
```

### Multi-Tenant Iteration

The `generate-all-insights` job:
1. Queries all tenants that have at least one `Transaction` record.
2. Iterates each tenant with `generateInsights(tenant.id)`.
3. Waits 1 second between tenants to avoid rate limiting.
4. Wraps each tenant in a try/catch — one tenant's failure doesn't stop the batch.
5. Reports per-tenant failures to Sentry with `worker` and `tenantId` context.

---

## 15.9. Internal Route

`POST /api/insights/generate` — defined in `src/routes/insights.js`.

| Aspect | Detail |
|--------|--------|
| Auth | `apiKeyAuth` middleware (service-to-service, `x-api-key` header) |
| Body | `{ tenantId: string }` (required) |
| Response | `202 Accepted` — `{ message: "Insight generation job enqueued" }` |
| Error | `400` if `tenantId` missing; `500` on queue failure |

Enqueues a `generate-tenant-insights` job on the `insights` queue.

---

## 15.10. Data Model

### `Insight`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `Int @id @default(autoincrement())` | Primary key |
| `tenantId` | `String` | FK to Tenant |
| `batchId` | `String` | Groups insights from the same generation run (`crypto.randomUUID()`) |
| `date` | `DateTime` | Generation date (midnight UTC) |
| `lens` | `String` | One of the 7 lens identifiers |
| `title` | `String` | Insight title (max 255 chars, 8 words max per LLM instruction) |
| `body` | `String` | Insight body (2-4 sentences with specific numbers) |
| `severity` | `String` | `POSITIVE`, `INFO`, `WARNING`, or `CRITICAL` |
| `priority` | `Int` | 1-100 (higher = more important) |
| `dataHash` | `String` | SHA-256 of the input data — used for deduplication |
| `metadata` | `Json?` | Optional lens-specific data points |
| `dismissed` | `Boolean @default(false)` | User-dismissible |
| `createdAt` | `DateTime @default(now())` | Creation timestamp |

### Indexes

- `@@index([tenantId, date])` — for date-range queries
- `@@index([tenantId, batchId])` — for batch lookups

### Relation

`Tenant.insights Insight[]` — one-to-many.

---

## 15.11. Storage Strategy

Insight generation replaces the previous batch atomically:

```javascript
await prisma.$transaction([
  prisma.insight.deleteMany({ where: { tenantId } }),
  prisma.insight.createMany({ data: insightRecords }),
]);
```

Before storage, raw LLM output is validated:
- Filtered for required fields (`lens`, `title`, `body`)
- `title` truncated to 255 chars
- `severity` validated against enum (defaults to `INFO`)
- `priority` clamped to 1-100 (defaults to 50)
- `dataHash` attached to every record for future deduplication

---

## 15.12. Centralized Worker Shutdown

All 7 workers (including `insightGeneratorWorker`) return their BullMQ `Worker` instance from their `start*Worker()` function. `src/index.js` collects them in a `workers[]` array:

```javascript
const workers = [];
// ...
workers.push(startInsightGeneratorWorker());
```

Graceful shutdown closes workers before disconnecting Redis:

```javascript
const gracefulShutdown = async () => {
  await Promise.allSettled(workers.map((w) => w.close()));
  await disconnectRedis();
  process.exit(0);
};
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
```

This ensures workers finish in-flight jobs and release their locks before the Redis connection is torn down. Individual workers no longer register their own SIGTERM/SIGINT handlers.

---

## 15.13. Future Enhancements

- **Streaming/conversational follow-up** — Allow users to ask follow-up questions about a specific insight via a chat interface.
- **Custom user-defined lenses** — Let tenants define their own analysis perspectives (e.g., "vacation spending", "side hustle income").
- **Historical insight comparison** — Track how insights evolve over time (trend of trends).
- **Multi-model support** — Provider abstraction layer for Claude, GPT, and other LLMs alongside Gemini.
- **Critical severity notifications** — Webhook/push notification when a CRITICAL insight is generated.
- **Per-tenant cron scheduling** — Allow tenants in different timezones to receive insights at their local morning.
- **Insight feedback loop** — Thumbs up/down on insights to fine-tune prompt quality over time.
- **Cross-currency analytics aggregation** — Convert all transaction currencies to portfolio currency instead of filtering by `currency: portfolioCurrency` (captures transactions in non-portfolio currencies).
