#!/usr/bin/env node
/**
 * Writes docs/guides/mcp-tool-reference.md from the MCP tool registry (#89).
 * Usage: pnpm --filter @bliss/api mcp:reference
 */
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderToolReference } from '../lib/mcp/reference.js';

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/guides/mcp-tool-reference.md');
writeFileSync(target, renderToolReference());
console.log(`Wrote ${target}`);
