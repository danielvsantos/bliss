/**
 * Robust JSON extraction from LLM text output.
 *
 * Providers without native JSON mode (Anthropic) return text that may contain
 * JSON in various shapes: fenced code blocks, custom tags, bare JSON with or
 * without a preamble. This helper tries each shape in order and throws a clear
 * error if no JSON is found.
 *
 * Gemini and OpenAI use native JSON mode and don't need this helper.
 */

/**
 * Extract a JSON value (object or array) from an arbitrary string.
 *
 * Tries, in order:
 *   1. Fenced code block:  ```json ... ```  or  ``` ... ```
 *   2. Tagged block:       <json>...</json>
 *   3. Bare JSON:          first `{` or `[` through end of parseable content
 *
 * @param {string} text
 * @returns {any} parsed JSON value (object, array, etc.)
 * @throws {Error} if no JSON can be located or parsed
 */
function extractJson(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Cannot extract JSON from empty or non-string input');
  }

  // 1. Fenced block (```json or plain ```)
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fencedMatch) {
    return parseOrThrow(fencedMatch[1].trim(), 'fenced block');
  }

  // 2. Tagged block (<json>...</json>)
  const taggedMatch = text.match(/<json>\s*([\s\S]+?)\s*<\/json>/i);
  if (taggedMatch) {
    return parseOrThrow(taggedMatch[1].trim(), 'tagged block');
  }

  // 3. Bare JSON — find first `{` or `[` and try to parse from there forward.
  //    We try progressively shorter suffixes so trailing commentary doesn't break us.
  const startIdx = text.search(/[{[]/);
  if (startIdx >= 0) {
    const candidate = text.slice(startIdx);
    return parseBareJson(candidate);
  }

  throw new Error('No JSON object or array found in LLM response');
}

/**
 * Parse a string that should be JSON, with a descriptive error on failure.
 * @private
 */
function parseOrThrow(str, source) {
  try {
    return JSON.parse(str);
  } catch (err) {
    throw new Error(`Failed to parse JSON from ${source}: ${err.message}`);
  }
}

/**
 * Parse a bare JSON string that may have trailing content after the value.
 * Uses brace/bracket matching to find the end of the first complete JSON value.
 * @private
 */
function parseBareJson(text) {
  // Try parsing the whole string first — fastest path when there's no trailing content.
  try {
    return JSON.parse(text);
  } catch (_) {
    // Fall through to structural scanning.
  }

  // Walk the string, tracking string/escape state, and find the matching closer
  // for the opening brace/bracket. Return the parsed content up to that point.
  const opener = text[0];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) {
      depth++;
    } else if (ch === closer) {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(0, i + 1);
        return parseOrThrow(candidate, 'bare JSON');
      }
    }
  }

  throw new Error('Bare JSON appears unterminated (unbalanced braces/brackets)');
}

module.exports = {
  extractJson,
};
