/**
 * Shared classification prompt helpers.
 *
 * The Gemini, OpenAI, and Anthropic adapters all classify transactions with
 * an essentially identical prompt — same sanitization, same rules, same
 * confidence scale, same output schema. Only the API envelope differs
 * (Gemini single-message, OpenAI system+user, Anthropic system+user with
 * <json>...</json> wrapping).
 *
 * This module owns the common parts so a content change (e.g. adding a
 * few-shot example or tightening the output schema) lands in one place
 * instead of three.
 *
 * Public API:
 *   • sanitizeDescription(text)
 *   • buildClassificationBody({ description, merchantName, amount, currency,
 *                               categories, plaidCategory })
 *   • validateClassificationResponse(parsed, categories)
 *       → returns { categoryId: number|null, confidence: number, reasoning: string }
 *       → throws on invalid integer ids (so the adapter can retry with feedback)
 *       → returns categoryId=null for the explicit "ambiguous" fallback
 */

// ─── Sanitization ─────────────────────────────────────────────────────────────

/**
 * Strip prompt-injection metacharacters from user-provided text.
 * Description and merchant text are routed verbatim into the prompt; the
 * <>{}` characters are commonly used to escape into instruction context.
 */
function sanitizeDescription(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/[<>{}`]/g, '').trim();
}

// ─── Prompt body ──────────────────────────────────────────────────────────────

/**
 * Build the shared classification prompt body.
 *
 * Adapters wrap this with their API-specific framing (system role for
 * OpenAI/Anthropic, top-of-message for Gemini) and tail (json_object mode
 * for OpenAI, <json>...</json> tags for Anthropic, plain JSON for Gemini).
 *
 * @param {Object} args
 * @param {string} args.description
 * @param {string|null} args.merchantName
 * @param {number|string|null} [args.amount]         — transaction amount (signed or absolute, caller decides)
 * @param {string|null} [args.currency]              — ISO currency code (e.g. "USD", "EUR")
 * @param {Array<{id:number,name:string,group:string,type:string}>} args.categories
 * @param {string|Object|null} [args.bankCategoryHint] — Bank-supplied category: either a Plaid
 *   personal_finance_category object {primary, detailed?, confidence_level?} or a plain string
 *   (e.g. from a CSV category column). Both are injected as advisory context into the LLM prompt.
 * @returns {string}
 */
function buildClassificationBody({ description, merchantName, amount, currency, categories, bankCategoryHint }) {
  const categoryList = categories
    .map((c) => `  ID: ${c.id} | Name: "${c.name}" | Group: "${c.group}" | Type: "${c.type}"`)
    .join('\n');

  const safeDescription = sanitizeDescription(description);
  const safeMerchant = merchantName ? sanitizeDescription(merchantName) : null;

  // Amount is a numeric signal that helps disambiguate ambiguous merchants
  // ("Amazon" at $5 is groceries, at $500 is electronics). Format
  // conservatively — show absolute value rounded to 2 decimals plus the
  // currency code. Skip the line entirely if no amount was passed (older
  // callers, manual flows). Negative-vs-positive convention varies between
  // sources (Plaid uses positive-debit, banks use negative-debit), so we
  // pass the magnitude only and let the model infer income vs. expense
  // from category type.
  let amountLine = '';
  if (amount != null && amount !== '' && Number.isFinite(Number(amount))) {
    const absAmount = Math.abs(Number(amount)).toFixed(2);
    const safeCurrency = currency ? sanitizeDescription(currency).toUpperCase() : '';
    amountLine = safeCurrency
      ? `Amount: ${safeCurrency} ${absAmount}\n`
      : `Amount: ${absAmount}\n`;
  }

  const transactionInfo = safeMerchant
    ? `${amountLine}[TRANSACTION_DESCRIPTION_START]${safeDescription}[TRANSACTION_DESCRIPTION_END]\n[MERCHANT_START]${safeMerchant}[MERCHANT_END]`
    : `${amountLine}[TRANSACTION_DESCRIPTION_START]${safeDescription}[TRANSACTION_DESCRIPTION_END]`;

  // Normalise bankCategoryHint: accept a plain string (CSV category column) or a Plaid
  // personal_finance_category object. Both become { primary, detailed?, confidence? }.
  let bankHintObj = null;
  if (bankCategoryHint) {
    if (typeof bankCategoryHint === 'string') {
      bankHintObj = { primary: bankCategoryHint };
    } else if (typeof bankCategoryHint === 'object') {
      bankHintObj = bankCategoryHint;
    }
  }

  let bankCategorySection = '';
  if (bankHintObj) {
    const primary = sanitizeDescription(bankHintObj.primary || bankHintObj.PRIMARY || '');
    const detailed = sanitizeDescription(bankHintObj.detailed || bankHintObj.DETAILED || '');
    const confidence = sanitizeDescription(
      bankHintObj.confidence_level || bankHintObj.CONFIDENCE_LEVEL || ''
    );
    if (primary) {
      bankCategorySection = `\nBANK CATEGORY HINT (from the source file — use as context, NOT as the answer):
Primary: "${primary}"${detailed ? `\nDetailed: "${detailed}"` : ''}${confidence ? `\nConfidence: "${confidence}"` : ''}\n`;
    }
  }

  // Few-shot examples — use category NAMES not IDs so the model maps each
  // example to the actual list above. Listing literal IDs would risk the
  // model copying them blindly into its answer (the IDs are tenant-specific).
  const examples = `EXAMPLES (calibration reference for confidence + format. Map example category names to the real IDs in your AVAILABLE CATEGORIES list above. Do NOT copy IDs from this section.)

Example 1 — clear single-merchant match, no Plaid hint:
  Transaction: USD 4.85, "STARBUCKS #1234", merchant "Starbucks"
  Best fit: a Food & Dining category.
  Output: { "categoryId": <Food & Dining ID>, "confidence": 0.82, "reasoning": "Coffee chain transaction; dining category fits." }

Example 2 — ambiguous merchant, amount disambiguates:
  Transaction: USD 8.50, "AMAZON.COM*MK4P12NL3"
  Best fit: a Shopping or Lifestyle category, but lower confidence — Amazon spans many categories.
  Output: { "categoryId": <Shopping ID>, "confidence": 0.55, "reasoning": "Small Amazon purchase, likely retail." }

Example 3 — globally recognized brand + bank hint matches + typical amount → ABSOLUTE CERTAINTY tier:
  Transaction: USD 4.85, "STARBUCKS #1234", merchant "Starbucks", bank hint "FOOD_AND_DRINK > FOOD_AND_DRINK_RESTAURANTS"
  Best fit: a Food & Dining category. Three signals all agree.
  Output: { "categoryId": <Food & Dining ID>, "confidence": 0.88, "reasoning": "Recognized brand, bank hint confirms, typical amount." }

Example 4 — bank hint elevates a less-recognizable merchant, but not to absolute certainty:
  Transaction: USD 412.00, "DELTA AIR LINES", bank hint "TRAVEL > AIRLINES_AND_AVIATION"
  Best fit: a Travel category.
  Output: { "categoryId": <Travel ID>, "confidence": 0.80, "reasoning": "Bank hint matches travel category strongly." }

Example 5 — genuinely ambiguous → use the FALLBACK:
  Transaction: USD 12.34, "ADJUSTMENT 0021", no merchant, no bank hint
  Output: { "categoryId": null, "confidence": 0.0, "reasoning": "Too ambiguous to classify" }
`;

  return `${examples}
TRANSACTION:
${transactionInfo}
${bankCategorySection}
AVAILABLE CATEGORIES:
${categoryList}

RULES:
1. Choose exactly one category from AVAILABLE CATEGORIES, OR return the FALLBACK below if no category clearly fits.
2. Consider the category name, group, and type when deciding.
3. Use the AMOUNT as a disambiguating signal — the same merchant at $5 vs $500 often belongs in different categories.
4. "Income" type categories are for income/salary/revenue transactions.
5. "Essentials" type categories are for non-discretionary spending (housing, groceries, health, transport, utilities).
6. "Lifestyle" type categories are for discretionary spending (dining out, entertainment, shopping, beauty).
7. "Growth" type categories are for long-term self-investment (education, travel, therapy, donations).
8. "Investments" type categories are for investment purchases/sales.
9. "Debt" type categories are for loan/credit payments.
10. "Transfers" type categories are for moving money between accounts.
11. If a BANK CATEGORY HINT is provided, weight it heavily but always map to the most appropriate category from YOUR list.

CONFIDENCE SCALE — calibrate your score to reflect genuine certainty:
- 0.86–0.90: ABSOLUTE CERTAINTY. Reserved for cases where ALL of the following hold simultaneously:
    (a) the merchant is a globally recognized brand whose primary business maps unambiguously to one category (e.g. Starbucks → dining, Netflix → entertainment, Uber → transport, payroll deposits from a known employer → income),
    (b) a BANK CATEGORY HINT is provided AND its primary value confirms the same category you are choosing,
    (c) the transaction amount falls in a range typical for that category (no contradictory signal — a $5,000 charge labelled "Starbucks" disqualifies the bulletproof tier).
  All three conditions must hold. If any is missing, drop to the 0.78–0.85 band. NEVER use this tier on a guess. NEVER exceed 0.90.
- 0.78–0.85: Certain. Only one category clearly fits this transaction; default tier for confident classifications without all three bulletproof signals.
- 0.65–0.77: Very confident. This category clearly fits; minor ambiguity exists.
- 0.50–0.64: Confident. This category fits best, but 1–2 alternatives could reasonably apply.
- 0.30–0.49: Uncertain. Multiple categories could apply; pick the most likely.
- 0.00–0.29: Very uncertain — prefer the FALLBACK below over a low-confidence guess.
Important: Your maximum possible score is 0.90, and only under the strict triple criterion above. Default to 0.78–0.85 when in doubt. Over-confidence causes incorrect automatic approvals; under-confidence creates unnecessary manual review work. Be accurate.

FALLBACK — for genuinely ambiguous transactions:
If no category fits with confidence ≥0.30 (e.g. opaque codes like "ADJUSTMENT 0021", generic "Wire transfer" with no other context, unrecognizable merchant strings), return:
{ "categoryId": null, "confidence": 0.0, "reasoning": "Too ambiguous to classify" }
Use this in preference to a wild guess. The transaction will be queued for manual review.

RESPONSE FORMAT (STRICT):
- categoryId must be an integer matching an ID from AVAILABLE CATEGORIES, OR null per FALLBACK. Never an integer outside the list.
- confidence must be a float 0.0–0.90. Never above 0.90, and the 0.86–0.90 band is only valid under the strict triple criterion above.
- reasoning must be a non-empty string ≤100 characters.
Return ONLY the JSON object — no markdown, no code fences, no prose outside the JSON.

Schema:
{ "categoryId": <integer|null>, "confidence": <float>, "reasoning": "<string>" }`;
}

// ─── Response validation ──────────────────────────────────────────────────────

/**
 * Validate and normalize an LLM classification response.
 *
 * Returns a result object the adapter can return verbatim, OR throws if the
 * response contained an integer that isn't in the tenant's category list (the
 * adapter retries those with a CORRECTION feedback line — deterministic
 * models otherwise return the same wrong ID forever).
 *
 * Null categoryId is the explicit ambiguous-fallback signal and is NOT an
 * error: it propagates through to the categorization service which surfaces
 * it to the worker as a successful "no category" classification, and the
 * worker routes the row to manual review.
 *
 * @param {Object} parsed              — the parsed JSON object from the LLM
 * @param {Array<{id:number}>} categories
 * @returns {{ categoryId: number|null, confidence: number, reasoning: string }}
 */
function validateClassificationResponse(parsed, categories) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid LLM response structure: ${JSON.stringify(parsed)}`);
  }

  const rawId = parsed.categoryId;
  const rawConfidence = parsed.confidence;

  if (typeof rawConfidence !== 'number' || Number.isNaN(rawConfidence)) {
    throw new Error(`Invalid LLM response — confidence must be a number: ${JSON.stringify(parsed)}`);
  }

  // Explicit FALLBACK path — model declared the transaction ambiguous.
  if (rawId === null) {
    return {
      categoryId: null,
      // Pin to 0 — model's stated confidence under FALLBACK is irrelevant
      // (it wasn't confident enough to pick anything).
      confidence: 0,
      reasoning: parsed.reasoning || 'Too ambiguous to classify',
    };
  }

  // Otherwise must be an integer matching the tenant's category list.
  if (rawId === undefined || rawId === '') {
    throw new Error(`Invalid LLM response — missing categoryId: ${JSON.stringify(parsed)}`);
  }
  const parsedId = Number(rawId);
  if (!Number.isInteger(parsedId)) {
    throw new Error(`Invalid LLM response — categoryId must be integer or null: ${JSON.stringify(parsed)}`);
  }
  const validCategory = categories.find((c) => c.id === parsedId);
  if (!validCategory) {
    // Surface as InvalidCategoryError so the adapter knows to attach a
    // CORRECTION feedback line on retry.
    const err = new Error(`LLM returned categoryId ${parsedId} not in provided categories`);
    err.invalidCategoryId = parsedId;
    throw err;
  }

  return {
    categoryId: parsedId,
    // Hard cap at 0.90. The prompt restricts the 0.86–0.90 band to a strict
    // triple criterion (recognizable brand + matching Plaid hint + typical
    // amount), giving the LLM exactly one path to auto-promote at the
    // default tenant threshold (0.90). Tenants who want stricter behavior
    // raise their `autoPromoteThreshold` to 0.91+; tenants who want looser
    // can lower it.
    confidence: Math.min(Math.max(rawConfidence, 0), 0.90),
    reasoning: parsed.reasoning || '',
  };
}

module.exports = {
  sanitizeDescription,
  buildClassificationBody,
  validateClassificationResponse,
};
