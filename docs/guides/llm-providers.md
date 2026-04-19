# Choosing an LLM Provider

Bliss needs an LLM to do two things it cannot work without: classify transactions it has never seen before (Tier 4 of the classification waterfall), and generate the financial insights that show up on your dashboard. Without one of the three supported providers configured, new merchants stay unclassified until you review them by hand, and the insights page stays empty.

This guide walks you through picking a provider, configuring it, and switching between them safely.

---

## Supported providers

| Provider | Embeddings | Classification | Insights | Notes |
|---|---|---|---|---|
| **Google Gemini** | `gemini-embedding-001` (native 3072-dim, projected to 768) | `gemini-3-flash-preview` | `gemini-3.1-pro-preview` | Recommended for new installs. Native embedding support keeps setup to a single key. |
| **OpenAI** | `text-embedding-3-small` (native 1536-dim, projected to 768) | `gpt-4.1-mini` | `gpt-4.1` | Native embedding support. Good fit if you already have OpenAI billing set up. |
| **Anthropic Claude** | *(no embedding API)* | `claude-sonnet-4-6` | `claude-sonnet-4-6` | Best prose quality for insights, but requires a second provider for embeddings. |

All three providers produce 768-dimensional embeddings and return classifications in the same JSON shape. Switching providers does not change any API contracts or database schema.

---

## Quick decision guide

Pick **Gemini** if:
- You want the simplest setup (one key, one provider, done).
- You are running Bliss on a free tier and want the most generous free quota.

Pick **OpenAI** if:
- You already have an OpenAI account and billing you trust.
- You prefer OpenAI's classification model behavior.

Pick **Anthropic Claude** if:
- You want the highest-quality prose for monthly, quarterly, and annual insight reports.
- You are comfortable configuring a second provider for embeddings.

---

## Configuration

All configuration happens in `.env`. There are no per-tenant settings and no database migrations involved.

### Gemini (default)

```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
```

That's it. Embeddings, classification, and insights all use Gemini.

### OpenAI

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

### Anthropic Claude

Anthropic does not expose an embedding API. You must configure a secondary provider (Gemini or OpenAI) for embeddings:

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

If you forget to set `EMBEDDING_PROVIDER`, Bliss fails loudly at startup with a clear message. The app will not run in a broken state.

### Model overrides

Each slot has a sensible default, but you can override any of them:

```env
EMBEDDING_MODEL=text-embedding-3-large   # override just embeddings
CLASSIFICATION_MODEL=gpt-4.1              # override just classification
INSIGHT_MODEL=gpt-4.1                     # override just insights
```

Model overrides are honored by whichever adapter is active. Omit them unless you need to pin a specific model version.

---

## Interactive setup

The `./scripts/setup.sh` script prompts you for an LLM provider as part of the first-run flow, before it generates your secrets. If you pick Anthropic it follows up with an embedding-provider prompt. The chosen provider and key(s) are written into `.env` automatically.

If you already have a `.env` and want to switch providers, edit the file directly — `setup.sh` will not overwrite an existing `.env`.

---

## Switching providers later

Switching is safe and reversible. The exact steps depend on what you're changing.

### Changing only the classification / insights provider

For example, moving from Gemini to Anthropic while keeping Gemini for embeddings:

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
EMBEDDING_PROVIDER=gemini
# GEMINI_API_KEY is already set
```

Restart the `api` and `backend` services. New classifications and insights use the new provider immediately. Existing embeddings stay valid because the embedding provider didn't change.

### Changing the embedding provider

Vectors from one provider aren't comparable with vectors from another — even at the same dimensionality. When you switch `EMBEDDING_PROVIDER`, the stored embeddings become stale and Tier 2/3 vector search starts returning nonsense until the index is rebuilt.

The workflow mirrors encryption key rotation:

1. Update `.env` with the new `EMBEDDING_PROVIDER` (and its API key).
2. Restart `api` and `backend`.
3. Run the re-embed script:

```bash
# Dry run first — counts the rows that need work without calling the API
node scripts/regenerate-embeddings.js --dry-run

# Full rebuild
node scripts/regenerate-embeddings.js

# One tenant at a time
node scripts/regenerate-embeddings.js --tenant=<tenantId>

# Smaller batches (default 100) if you want gentler rate usage
node scripts/regenerate-embeddings.js --batch=50
```

The script is idempotent — you can re-run it after a crash or ctrl-C.

**What gets re-embedded:**

- `TransactionEmbedding` rows linked to a committed transaction (the vast majority). Plaintext is recovered automatically by joining to `Transaction.description`, which Prisma decrypts transparently.
- Pre-commit staged rows (where `transactionId IS NULL`) are skipped — they regenerate naturally when the user confirms the staged import on the new provider.
- `GlobalEmbedding` is not touched — its stored text is a SHA-256 hash with no recoverable plaintext. Global entries repopulate incrementally as users confirm classifications on the new provider. If you want a clean global slate, `TRUNCATE "GlobalEmbedding"` in psql before restarting.

---

## Graceful degradation

If the LLM provider's API key is unset or invalid:

- **Tier 1 (exact match) still works.** Every merchant you have already classified is recognized instantly.
- **Tier 2/3 (vector search) is disabled** for embedding failures — new unseen merchants cannot be matched semantically.
- **Tier 4 (LLM) is disabled.** Unseen merchants remain unclassified until you review them manually.
- **Insights are unavailable.** The insights page stays empty.

No data is lost, and the rest of the app (transactions, portfolio, analytics) continues working normally.

---

## Troubleshooting

### "LLM_PROVIDER=anthropic requires EMBEDDING_PROVIDER to be set explicitly"

You set `LLM_PROVIDER=anthropic` but didn't configure a secondary embedding provider. Add `EMBEDDING_PROVIDER=gemini` (or `openai`) to `.env` and the matching API key.

### "EMBEDDING_PROVIDER cannot be anthropic"

You tried to use Anthropic for embeddings. Anthropic does not provide an embedding API — use Gemini or OpenAI for this slot.

### Vector search returns bad matches after switching providers

You changed `EMBEDDING_PROVIDER` but did not rebuild the index. Run `node scripts/regenerate-embeddings.js`.

### Rate-limit errors in the logs

The adapters retry automatically with minute-scale backoff. If you consistently hit quota, check your provider dashboard and either increase your plan or lower the classification volume (for example, by reducing `PHASE2_CONCURRENCY` in `apps/backend/src/config/classificationConfig.js`).

---

## Next steps

- [AI Classification](/docs/guides/ai-classification) — how the 4-tier pipeline uses your chosen LLM
- [Financial Insights](/docs/guides/financial-insights) — what the insights engine does with it
- [External Services](/docs/guides/external-services) — other integrations (Plaid, Twelve Data, CurrencyLayer)
