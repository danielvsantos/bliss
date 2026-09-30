/**
 * The committed MCP tool reference (docs/guides/mcp-tool-reference.md) must
 * match the registry (#89, AC16). Regenerate with
 * `pnpm --filter @bliss/api mcp:reference`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderToolReference } from '../../../lib/mcp/reference.js';
import { ALL_TOOLS } from '../../../lib/mcp/registry.js';

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../docs/guides/mcp-tool-reference.md');

describe('MCP tool reference', () => {
  it('is up to date (run pnpm --filter @bliss/api mcp:reference)', () => {
    expect(readFileSync(FILE, 'utf8')).toBe(renderToolReference());
  });

  it('documents every tool and its wrapped routes', () => {
    const doc = renderToolReference();
    for (const tool of ALL_TOOLS) {
      expect(doc).toContain(`### \`${tool.name}\``);
      for (const w of tool.wraps) expect(doc).toContain(`\`${w.method} ${w.route}\``);
    }
  });
});
