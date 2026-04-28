// ─── classificationPromptHelpers.test.js ──────────────────────────────────────
// Direct unit tests for the shared classification prompt module. These are the
// "Phase 2 quick wins" coverage — adapter integration tests verify each
// provider still wires the helper correctly, but content-level assertions
// (few-shot examples, FALLBACK section, STRICT format, amount/currency line)
// live here so they're tested once instead of three times.

const {
  sanitizeDescription,
  buildClassificationBody,
  validateClassificationResponse,
} = require('../../../../services/llm/classificationPromptHelpers');

const MOCK_CATEGORIES = [
  { id: 1, name: 'Food & Dining', group: 'Food', type: 'Lifestyle' },
  { id: 2, name: 'Transport', group: 'Transport', type: 'Essentials' },
  { id: 3, name: 'Salary', group: 'Income', type: 'Income' },
];

describe('classificationPromptHelpers', () => {
  // ─── sanitizeDescription ──────────────────────────────────────────────────

  describe('sanitizeDescription()', () => {
    it('strips prompt-injection metacharacters', () => {
      expect(sanitizeDescription('<ignore>{evil}`drop`')).toBe('ignoreevildrop');
    });

    it('returns empty string for nullish input', () => {
      expect(sanitizeDescription(null)).toBe('');
      expect(sanitizeDescription(undefined)).toBe('');
      expect(sanitizeDescription('')).toBe('');
    });

    it('returns empty string for non-string input', () => {
      expect(sanitizeDescription(123)).toBe('');
      expect(sanitizeDescription({})).toBe('');
    });

    it('trims surrounding whitespace', () => {
      expect(sanitizeDescription('  hello  ')).toBe('hello');
    });
  });

  // ─── buildClassificationBody ──────────────────────────────────────────────

  describe('buildClassificationBody()', () => {
    const baseArgs = {
      description: 'Starbucks #1234',
      merchantName: 'Starbucks',
      categories: MOCK_CATEGORIES,
      bankCategoryHint: null,
    };

    it('includes the AMOUNT line with currency when amount is provided', () => {
      const body = buildClassificationBody({ ...baseArgs, amount: 4.85, currency: 'USD' });
      expect(body).toMatch(/Amount: USD 4\.85/);
    });

    it('formats amount as absolute (sign-agnostic)', () => {
      const body = buildClassificationBody({ ...baseArgs, amount: -42.5, currency: 'EUR' });
      expect(body).toMatch(/Amount: EUR 42\.50/);
      expect(body).not.toMatch(/-42/);
    });

    it('omits the AMOUNT line when amount is null/undefined/empty', () => {
      const noAmount = buildClassificationBody({ ...baseArgs, amount: null, currency: 'USD' });
      expect(noAmount).not.toMatch(/Amount:/);

      const undef = buildClassificationBody(baseArgs);
      expect(undef).not.toMatch(/Amount:/);

      const empty = buildClassificationBody({ ...baseArgs, amount: '', currency: 'USD' });
      expect(empty).not.toMatch(/Amount:/);
    });

    it('formats amount without currency when currency is missing', () => {
      const body = buildClassificationBody({ ...baseArgs, amount: 99.99, currency: null });
      expect(body).toMatch(/Amount: 99\.99/);
      // No leading currency code
      expect(body).not.toMatch(/Amount: [A-Z]+ /);
    });

    it('uppercases the currency code', () => {
      const body = buildClassificationBody({ ...baseArgs, amount: 1, currency: 'gbp' });
      expect(body).toMatch(/Amount: GBP/);
    });

    it('includes the 4 few-shot examples (Starbucks, Amazon, Delta, Adjustment)', () => {
      const body = buildClassificationBody(baseArgs);
      expect(body).toMatch(/EXAMPLES \(calibration reference/);
      expect(body).toMatch(/STARBUCKS/);
      expect(body).toMatch(/AMAZON/);
      expect(body).toMatch(/DELTA AIR LINES/);
      expect(body).toMatch(/ADJUSTMENT 0021/);
    });

    it('few-shot examples reference category names not IDs (so model maps to actual categories)', () => {
      const body = buildClassificationBody(baseArgs);
      // The placeholders use angle brackets that get stripped by sanitization in
      // the BODY OUTPUT — so the examples in the prompt show category NAMES, not
      // IDs. Verify the placeholders are present.
      expect(body).toMatch(/<Food & Dining ID>/);
      expect(body).toMatch(/<Shopping ID>/);
      expect(body).toMatch(/<Travel ID>/);
    });

    it('includes the FALLBACK section that allows the model to return null', () => {
      const body = buildClassificationBody(baseArgs);
      expect(body).toMatch(/FALLBACK/);
      expect(body).toMatch(/"categoryId": null/);
      expect(body).toMatch(/Too ambiguous to classify/);
    });

    it('includes the STRICT response format with bounds (cap is 0.90)', () => {
      const body = buildClassificationBody(baseArgs);
      expect(body).toMatch(/RESPONSE FORMAT \(STRICT\)/);
      expect(body).toMatch(/integer matching an ID from AVAILABLE CATEGORIES, OR null/);
      expect(body).toMatch(/0\.0–0\.90/);
      expect(body).toMatch(/no markdown, no code fences/);
    });

    it('describes the 0.86–0.90 ABSOLUTE CERTAINTY tier with the strict triple criterion', () => {
      const body = buildClassificationBody(baseArgs);
      expect(body).toMatch(/0\.86–0\.90: ABSOLUTE CERTAINTY/);
      // Three signals must all hold — assert the specific gates the model
      // must check before using the top band.
      expect(body).toMatch(/globally recognized brand/);
      expect(body).toMatch(/BANK CATEGORY HINT is provided AND its primary value confirms/);
      expect(body).toMatch(/typical for that category/);
      expect(body).toMatch(/All three conditions must hold/);
    });

    it('demonstrates the ABSOLUTE CERTAINTY tier in the few-shot examples', () => {
      const body = buildClassificationBody(baseArgs);
      // Example 3 in the helper shows the bulletproof case at 0.88.
      expect(body).toMatch(/ABSOLUTE CERTAINTY tier/);
      expect(body).toMatch(/"confidence": 0\.88/);
    });

    it('lists categories with id, name, group, type', () => {
      const body = buildClassificationBody(baseArgs);
      expect(body).toMatch(/ID: 1 \| Name: "Food & Dining"/);
      expect(body).toMatch(/ID: 2 \| Name: "Transport"/);
      expect(body).toMatch(/ID: 3 \| Name: "Salary"/);
    });

    it('embeds the description and merchant inside the sentinel delimiters', () => {
      const body = buildClassificationBody(baseArgs);
      expect(body).toMatch(/\[TRANSACTION_DESCRIPTION_START\]Starbucks #1234\[TRANSACTION_DESCRIPTION_END\]/);
      expect(body).toMatch(/\[MERCHANT_START\]Starbucks\[MERCHANT_END\]/);
    });

    it('omits the merchant block when merchantName is null', () => {
      const body = buildClassificationBody({ ...baseArgs, merchantName: null });
      expect(body).not.toMatch(/MERCHANT_START/);
    });

    it('includes a BANK CATEGORY HINT section when bankCategoryHint is a Plaid object', () => {
      const body = buildClassificationBody({
        ...baseArgs,
        bankCategoryHint: { primary: 'TRAVEL', detailed: 'TRAVEL_AIRLINES', confidence_level: 'HIGH' },
      });
      expect(body).toMatch(/BANK CATEGORY HINT/);
      expect(body).toMatch(/Primary: "TRAVEL"/);
      expect(body).toMatch(/Detailed: "TRAVEL_AIRLINES"/);
      expect(body).toMatch(/Confidence: "HIGH"/);
    });

    it('includes a BANK CATEGORY HINT section when bankCategoryHint is a plain string', () => {
      const body = buildClassificationBody({
        ...baseArgs,
        bankCategoryHint: 'Food & Drink',
      });
      expect(body).toMatch(/BANK CATEGORY HINT/);
      expect(body).toMatch(/Primary: "Food & Drink"/);
    });

    it('omits the bank hint block (Primary/Detailed/Confidence) when bankCategoryHint has no primary', () => {
      const body = buildClassificationBody({ ...baseArgs, bankCategoryHint: { primary: '' } });
      expect(body).not.toMatch(/Primary: "[^"]+"/);
    });

    it('sanitizes bank hint values to strip injection chars', () => {
      const body = buildClassificationBody({
        ...baseArgs,
        bankCategoryHint: { primary: '<inject>TRAVEL', detailed: '`evil`AIRLINES' },
      });
      expect(body).not.toMatch(/<inject>/);
      expect(body).not.toMatch(/`evil`/);
      expect(body).toMatch(/Primary: "injectTRAVEL"/);
    });
  });

  // ─── validateClassificationResponse ───────────────────────────────────────

  describe('validateClassificationResponse()', () => {
    it('returns the normalized result for a valid integer categoryId', () => {
      const result = validateClassificationResponse(
        { categoryId: 1, confidence: 0.82, reasoning: 'coffee' },
        MOCK_CATEGORIES,
      );
      expect(result).toEqual({ categoryId: 1, confidence: 0.82, reasoning: 'coffee' });
    });

    it('coerces string categoryId to a number', () => {
      const result = validateClassificationResponse(
        { categoryId: '2', confidence: 0.7, reasoning: 'x' },
        MOCK_CATEGORIES,
      );
      expect(result.categoryId).toBe(2);
      expect(typeof result.categoryId).toBe('number');
    });

    it('clamps confidence to the [0, 0.90] range (cap raised to allow ABSOLUTE CERTAINTY tier)', () => {
      const high = validateClassificationResponse(
        { categoryId: 1, confidence: 1.5, reasoning: 'x' },
        MOCK_CATEGORIES,
      );
      expect(high.confidence).toBe(0.90);

      const low = validateClassificationResponse(
        { categoryId: 1, confidence: -0.3, reasoning: 'x' },
        MOCK_CATEGORIES,
      );
      expect(low.confidence).toBe(0);
    });

    it('passes through a 0.88 ABSOLUTE CERTAINTY confidence unchanged', () => {
      const result = validateClassificationResponse(
        { categoryId: 1, confidence: 0.88, reasoning: 'recognized + plaid + typical' },
        MOCK_CATEGORIES,
      );
      expect(result.confidence).toBe(0.88);
    });

    it('accepts categoryId=null as the FALLBACK signal and pins confidence to 0', () => {
      const result = validateClassificationResponse(
        { categoryId: null, confidence: 0.4, reasoning: 'no match' },
        MOCK_CATEGORIES,
      );
      expect(result.categoryId).toBeNull();
      // Stated confidence is overridden — model wasn't confident enough to pick.
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toBe('no match');
    });

    it('uses a default reasoning string when FALLBACK omits it', () => {
      const result = validateClassificationResponse(
        { categoryId: null, confidence: 0 },
        MOCK_CATEGORIES,
      );
      expect(result.reasoning).toBe('Too ambiguous to classify');
    });

    it('throws when categoryId is an integer not in the categories list, attaching invalidCategoryId for retry', () => {
      let thrown;
      try {
        validateClassificationResponse(
          { categoryId: 999, confidence: 0.8, reasoning: 'x' },
          MOCK_CATEGORIES,
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrown.invalidCategoryId).toBe(999);
      expect(thrown.message).toMatch(/categoryId 999 not in provided categories/);
    });

    it('throws when categoryId is a non-integer, non-null value', () => {
      expect(() =>
        validateClassificationResponse(
          { categoryId: 1.5, confidence: 0.8, reasoning: 'x' },
          MOCK_CATEGORIES,
        ),
      ).toThrow(/must be integer or null/);

      expect(() =>
        validateClassificationResponse(
          { categoryId: 'foo', confidence: 0.8, reasoning: 'x' },
          MOCK_CATEGORIES,
        ),
      ).toThrow(/must be integer or null/);
    });

    it('throws when categoryId is missing entirely', () => {
      expect(() =>
        validateClassificationResponse(
          { confidence: 0.8, reasoning: 'x' },
          MOCK_CATEGORIES,
        ),
      ).toThrow(/missing categoryId/);
    });

    it('throws when confidence is not a number', () => {
      expect(() =>
        validateClassificationResponse(
          { categoryId: 1, confidence: 'high', reasoning: 'x' },
          MOCK_CATEGORIES,
        ),
      ).toThrow(/confidence must be a number/);
    });

    it('throws when the parsed value is not an object', () => {
      expect(() => validateClassificationResponse(null, MOCK_CATEGORIES)).toThrow(/Invalid LLM response structure/);
      expect(() => validateClassificationResponse('foo', MOCK_CATEGORIES)).toThrow(/Invalid LLM response structure/);
    });
  });
});
