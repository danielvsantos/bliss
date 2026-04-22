const { extractJson } = require('../../../../services/llm/jsonExtractor');

describe('extractJson', () => {
  describe('fenced code blocks', () => {
    it('extracts JSON from ```json ... ``` block', () => {
      const text = 'Here is the result:\n```json\n{"categoryId": 1, "confidence": 0.8}\n```';
      expect(extractJson(text)).toEqual({ categoryId: 1, confidence: 0.8 });
    });

    it('extracts JSON from ``` ... ``` block with no language tag', () => {
      const text = '```\n{"a": 1, "b": 2}\n```';
      expect(extractJson(text)).toEqual({ a: 1, b: 2 });
    });

    it('extracts JSON arrays from fenced blocks', () => {
      const text = '```json\n[{"id": 1}, {"id": 2}]\n```';
      expect(extractJson(text)).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('is case-insensitive for the json language tag', () => {
      const text = '```JSON\n{"x": true}\n```';
      expect(extractJson(text)).toEqual({ x: true });
    });

    it('tolerates whitespace around the fenced content', () => {
      const text = '```json\n\n   {"a": 1}   \n\n```';
      expect(extractJson(text)).toEqual({ a: 1 });
    });

    it('returns the first fenced block when multiple exist', () => {
      const text = '```json\n{"first": true}\n```\nthen\n```json\n{"second": true}\n```';
      expect(extractJson(text)).toEqual({ first: true });
    });

    it('throws with a descriptive message when fenced content is malformed', () => {
      const text = '```json\n{"unclosed": \n```';
      expect(() => extractJson(text)).toThrow(/Failed to parse JSON from fenced block/);
    });
  });

  describe('tagged blocks', () => {
    it('extracts JSON from <json>...</json>', () => {
      const text = 'preamble <json>{"categoryId": 5, "confidence": 0.7}</json> epilogue';
      expect(extractJson(text)).toEqual({ categoryId: 5, confidence: 0.7 });
    });

    it('is case-insensitive for tags', () => {
      const text = '<JSON>{"ok": 1}</JSON>';
      expect(extractJson(text)).toEqual({ ok: 1 });
    });

    it('tolerates whitespace inside tags', () => {
      const text = '<json>\n  {"a": 1}\n</json>';
      expect(extractJson(text)).toEqual({ a: 1 });
    });

    it('throws when tagged content is malformed', () => {
      const text = '<json>{broken}</json>';
      expect(() => extractJson(text)).toThrow(/Failed to parse JSON from tagged block/);
    });
  });

  describe('bare JSON', () => {
    it('parses a bare JSON object', () => {
      expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
    });

    it('parses a bare JSON array', () => {
      expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    it('parses JSON after a preamble', () => {
      const text = "Here's the classification: {\"categoryId\": 2, \"confidence\": 0.6}";
      expect(extractJson(text)).toEqual({ categoryId: 2, confidence: 0.6 });
    });

    it('parses JSON object followed by trailing commentary', () => {
      const text = '{"a": 1} I hope that helps!';
      expect(extractJson(text)).toEqual({ a: 1 });
    });

    it('parses JSON array followed by trailing commentary', () => {
      const text = '[{"id": 1}, {"id": 2}] — let me know if you need more.';
      expect(extractJson(text)).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('handles nested objects correctly', () => {
      const text = '{"outer": {"inner": {"deep": true}}, "sibling": 1} extra text';
      expect(extractJson(text)).toEqual({
        outer: { inner: { deep: true } },
        sibling: 1,
      });
    });

    it('handles strings containing brace characters', () => {
      const text = '{"msg": "hello {world}", "n": 1} done';
      expect(extractJson(text)).toEqual({ msg: 'hello {world}', n: 1 });
    });

    it('handles escaped quotes inside strings', () => {
      const text = '{"msg": "she said \\"hi\\"", "n": 1}';
      expect(extractJson(text)).toEqual({ msg: 'she said "hi"', n: 1 });
    });

    it('handles escaped backslashes', () => {
      const text = '{"path": "C:\\\\Users\\\\test"}';
      expect(extractJson(text)).toEqual({ path: 'C:\\Users\\test' });
    });

    it('supports unicode in values', () => {
      const text = '{"emoji": "🎉", "kanji": "日本語"}';
      expect(extractJson(text)).toEqual({ emoji: '🎉', kanji: '日本語' });
    });

    it('throws on unterminated bare JSON', () => {
      const text = '{"a": 1, "b": ';
      expect(() => extractJson(text)).toThrow(/unterminated|Failed to parse/i);
    });
  });

  describe('error cases', () => {
    it('throws on empty string', () => {
      expect(() => extractJson('')).toThrow(/empty or non-string/);
    });

    it('throws on null', () => {
      expect(() => extractJson(null)).toThrow(/empty or non-string/);
    });

    it('throws on undefined', () => {
      expect(() => extractJson(undefined)).toThrow(/empty or non-string/);
    });

    it('throws on non-string input', () => {
      expect(() => extractJson(123)).toThrow(/empty or non-string/);
      expect(() => extractJson({})).toThrow(/empty or non-string/);
    });

    it('throws when no JSON is found at all', () => {
      expect(() => extractJson('just some prose, no json here')).toThrow(
        /No JSON object or array found/
      );
    });
  });

  describe('priority order', () => {
    it('prefers fenced block over tagged block', () => {
      const text = '<json>{"tagged": true}</json>\n```json\n{"fenced": true}\n```';
      expect(extractJson(text)).toEqual({ fenced: true });
    });

    it('prefers tagged block over bare JSON', () => {
      const text = '{"bare": true} <json>{"tagged": true}</json>';
      expect(extractJson(text)).toEqual({ tagged: true });
    });
  });
});
