// ─── schema.test.js ───────────────────────────────────────────────────────────
// The insight output schema must stay acceptable to all three providers'
// structured-output modes (#80 added a lens and an action type):
//   - OpenAI strict json_schema: every object has additionalProperties:false
//     and lists every property in `required`
//   - Gemini responseSchema: converted by toGeminiSchema (enums preserved)
//   - Anthropic forced tool use: the wrapped object schema as input_schema

jest.mock('../../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// insightService is only required for its lens constants — no DB access.
jest.mock('../../../../../prisma/prisma.js', () => ({}));
jest.mock('../../../../services/llm', () => ({ generateInsightContent: jest.fn() }));

const {
  insightItemSchema,
  insightWrappedSchema,
  VALID_LENSES,
  VALID_ACTION_TYPES,
} = require('../../../../services/insightPrompts/schema');
const { toGeminiSchema } = require('../../../../services/llm/geminiAdapter');
const insightService = require('../../../../services/insightService');

function walkObjects(schema, visit) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) visit(schema);
  for (const value of Object.values(schema.properties || {})) walkObjects(value, visit);
  if (schema.items) walkObjects(schema.items, visit);
}

describe('insightPrompts/schema', () => {
  it('accepts the PASSIVE_INCOME_OUTLOOK lens and the PASSIVE_INCOME_SETUP action', () => {
    expect(VALID_LENSES).toContain('PASSIVE_INCOME_OUTLOOK');
    expect(VALID_ACTION_TYPES).toContain('PASSIVE_INCOME_SETUP');
    expect(insightItemSchema.properties.lens.enum).toContain('PASSIVE_INCOME_OUTLOOK');
    expect(insightItemSchema.properties.metadata.properties.relatedLenses.items.enum).toContain('PASSIVE_INCOME_OUTLOOK');
    expect(insightItemSchema.properties.metadata.properties.actionTypes.items.enum).toContain('PASSIVE_INCOME_SETUP');
  });

  it('stays in sync with the service-level lens and action lists', () => {
    expect([...VALID_LENSES].sort()).toEqual(Object.keys(insightService.LENS_CATEGORY_MAP).sort());
    const tierLenses = new Set(Object.values(insightService.TIER_LENSES).flat());
    for (const lens of tierLenses) expect(VALID_LENSES).toContain(lens);
  });

  it('is OpenAI strict-mode compatible (closed objects, every property required)', () => {
    walkObjects(insightWrappedSchema, (obj) => {
      expect(obj.additionalProperties).toBe(false);
      expect([...(obj.required || [])].sort()).toEqual(Object.keys(obj.properties || {}).sort());
    });
  });

  it('converts to a Gemini responseSchema with the new enum values intact', () => {
    const out = toGeminiSchema(insightWrappedSchema);
    const item = out.properties.insights.items;
    expect(item.properties.lens.enum).toContain('PASSIVE_INCOME_OUTLOOK');
    expect(item.properties.metadata.properties.actionTypes.items.enum).toContain('PASSIVE_INCOME_SETUP');
    expect(JSON.stringify(out)).not.toMatch(/"additionalProperties"/);
  });

  it('is a plain object schema usable as an Anthropic tool input_schema', () => {
    expect(insightWrappedSchema.type).toBe('object');
    expect(insightWrappedSchema.properties.insights.type).toBe('array');
    expect(() => JSON.parse(JSON.stringify(insightWrappedSchema))).not.toThrow();
  });
});
