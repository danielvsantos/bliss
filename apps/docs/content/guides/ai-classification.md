# AI Classification

Every transaction in Bliss is classified by a 4-tier pipeline that learns from your corrections over time.

## The 4-tier waterfall

Each transaction flows through these tiers until one succeeds:

### Tier 1: Exact Match
An O(1) in-memory cache lookup by description. If you've categorized "NETFLIX" before, the next occurrence is matched instantly with confidence `1.0`.

### Tier 2: Vector Similarity (Tenant)
If no exact match, Bliss computes a vector embedding (Gemini, 768 dimensions) and queries pgvector for cosine similarity against your previous classifications. Threshold: `reviewThreshold` (default 0.70).

### Tier 3: Vector Similarity (Global)
Same as Tier 2 but searches across all tenants' embeddings. Results are discounted by 0.92x since cross-tenant matches are less reliable.

### Tier 4: LLM
If no vector match, Gemini 3 Flash (`gemini-3-flash-preview`) classifies the transaction with temperature 0.1. Confidence is hard-capped at 0.85 — LLM results always go through review.

## Enabling AI classification

Tier 1 works out of the box. Tiers 2-4 require a Gemini API key (Tier 2 needs it to generate embeddings, Tiers 3-4 use it for cross-tenant search and LLM classification):

```env
GEMINI_API_KEY=your_api_key
```

Without it, unmatched transactions remain unclassified for manual review.

## Training the model

The most important thing you can do is **review your first ~100 transactions carefully**. Every correction you make:

1. **Updates the exact-match cache** immediately (Tier 1)
2. **Generates a vector embedding** asynchronously (Tier 2)

After this initial training period, most transactions will match at Tier 1 or 2 with high confidence.

## Tuning thresholds

Two tenant-level thresholds control the pipeline behavior:

| Threshold | Default | Effect |
|-----------|---------|--------|
| `autoPromoteThreshold` | 0.90 | Classifications above this are saved without review |
| `reviewThreshold` | 0.70 | Minimum vector similarity score to accept a match |

Adjust these in **Settings** based on your comfort level. Lower `autoPromoteThreshold` = less manual review but more risk of misclassification.

## Expense tracking

Once classified, your transactions power the expense tracking dashboard with category breakdowns, monthly trends, and spending analysis.

![Expense tracking page](/images/expenses.png)

## Next steps

- [Importing transactions](/docs/guides/importing-transactions) — the review flow where you train the AI
- Explore the [AI Classification spec](/docs/specifications) for full technical details
