// ─── geminiSchemaConverter.test.js ────────────────────────────────────────────
// Tests for the Gemini-dialect schema conversion. Gemini's `responseSchema`
// follows OpenAPI 3.0 (a strict subset of JSON Schema) — passing the raw
// insight schema causes a 400 from the API. The converter must:
//   1. Strip `additionalProperties` everywhere.
//   2. Rewrite `type: ['T', 'null']` to `type: 'T'` plus `nullable: true`.
//
// Regression coverage for: "Unknown name 'additionalProperties'" and
// "Unknown name 'type' ... Proto field is not repeating" 400s during the
// Phase 3 rollout.

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { toGeminiSchema } = require('../../../../services/llm/geminiAdapter');
const { insightArraySchema } = require('../../../../services/insightPrompts/schema');

describe('toGeminiSchema()', () => {
  it('strips additionalProperties at every level', () => {
    const input = {
      type: 'object',
      additionalProperties: false,
      properties: {
        nested: {
          type: 'object',
          additionalProperties: false,
          properties: { x: { type: 'string' } },
        },
      },
    };
    const out = toGeminiSchema(input);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/additionalProperties/);
  });

  it('rewrites type-as-array to type + nullable=true', () => {
    const input = {
      type: 'object',
      properties: {
        amount: { type: ['number', 'null'] },
      },
    };
    const out = toGeminiSchema(input);
    expect(out.properties.amount.type).toBe('number');
    expect(out.properties.amount.nullable).toBe(true);
  });

  it('leaves single-string types untouched', () => {
    const input = { type: 'object', properties: { x: { type: 'string' } } };
    const out = toGeminiSchema(input);
    expect(out.properties.x.type).toBe('string');
    expect(out.properties.x.nullable).toBeUndefined();
  });

  it('preserves enum, required, items, minItems, maxItems, etc.', () => {
    const input = {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        required: ['lens'],
        properties: { lens: { type: 'string', enum: ['A', 'B'] } },
      },
    };
    const out = toGeminiSchema(input);
    expect(out.minItems).toBe(1);
    expect(out.maxItems).toBe(10);
    expect(out.items.required).toEqual(['lens']);
    expect(out.items.properties.lens.enum).toEqual(['A', 'B']);
  });

  it('handles null and primitive inputs without throwing', () => {
    expect(toGeminiSchema(null)).toBeNull();
    expect(toGeminiSchema(undefined)).toBeUndefined();
    expect(toGeminiSchema('string')).toBe('string');
    expect(toGeminiSchema(42)).toBe(42);
  });

  it('converts the real insightArraySchema to a Gemini-compatible shape', () => {
    const out = toGeminiSchema(insightArraySchema);
    const json = JSON.stringify(out);

    // The two specific Gemini errors that triggered Phase 3's rollout bug:
    expect(json).not.toMatch(/"additionalProperties"/);
    expect(json).not.toMatch(/"type":\s*\[/);

    // dataPoints had number-or-null types — verify the rewrite landed
    const dataPoints = out.items.properties.metadata.properties.dataPoints.properties;
    for (const key of ['current', 'prior', 'yoy', 'deltaPct']) {
      expect(dataPoints[key].type).toBe('number');
      expect(dataPoints[key].nullable).toBe(true);
    }
  });
});
