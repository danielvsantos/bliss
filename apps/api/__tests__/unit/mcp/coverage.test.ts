/**
 * MCP coverage (#89, AC12).
 *
 * Every REST operation an integration key can reach (per the #84 route matrix,
 * READ_WRITE outcome A or P) must be wrapped by an MCP tool xor listed in
 * lib/mcp/exclusions.js with a reason. No tool may wrap an operation a key
 * cannot reach. A new route therefore fails here until it is classified.
 */

import { describe, it, expect } from 'vitest';
import { ROUTE_MATRIX } from '../middleware/integrationRouteMatrix.data.js';
import { ALL_TOOLS } from '../../../lib/mcp/registry.js';
import { EXCLUDED_OPERATIONS, NOT_REST_OPERATIONS } from '../../../lib/mcp/exclusions.js';

/** `portfolio/items/[assetId]/manual-values.js` → `/api/portfolio/items/[assetId]/manual-values` */
function routeFor(file: string) {
  return `/api/${file.replace(/\.(js|ts)$/, '').replace(/(^|\/)index$/, '')}`.replace(/\/$/, '');
}

const op = (method: string, route: string) => `${method} ${route}`;

const reachable = new Set<string>();
const unreachable = new Set<string>();
for (const [file, spec] of Object.entries(ROUTE_MATRIX)) {
  for (const [method, pair] of Object.entries(spec.methods)) {
    const rw = pair.split('/')[1];
    (rw === 'A' || rw === 'P' ? reachable : unreachable).add(op(method, routeFor(file)));
  }
}
for (const { method, route } of NOT_REST_OPERATIONS) reachable.delete(op(method, route));

const wrapped = new Set(ALL_TOOLS.flatMap((t) => t.wraps.map((w: any) => op(w.method, w.route))));
const excluded = new Set(EXCLUDED_OPERATIONS.map((e) => op(e.method, e.route)));

describe('MCP coverage of reachable REST operations', () => {
  it('every reachable operation is wrapped by a tool or excluded', () => {
    const missing = [...reachable].filter((o) => !wrapped.has(o) && !excluded.has(o));
    expect(missing, 'Add a tool for these operations or list them in lib/mcp/exclusions.js').toEqual([]);
  });

  it('no operation is both wrapped and excluded', () => {
    expect([...excluded].filter((o) => wrapped.has(o))).toEqual([]);
  });

  it('tools only wrap operations an integration key can reach', () => {
    const bad = [...wrapped].filter((o) => !reachable.has(o));
    expect(bad).toEqual([]);
    expect([...wrapped].filter((o) => unreachable.has(o))).toEqual([]);
  });

  it('every exclusion is a reachable operation with a reason', () => {
    for (const e of EXCLUDED_OPERATIONS) {
      expect(reachable.has(op(e.method, e.route)), op(e.method, e.route)).toBe(true);
      expect(e.reason.length).toBeGreaterThan(10);
    }
  });

  it('totals: 86 reachable, 66 covered, 20 excluded', () => {
    expect(reachable.size).toBe(86);
    expect([...reachable].filter((o) => wrapped.has(o)).length).toBe(66);
    expect(excluded.size).toBe(20);
  });

  it('no file upload or Plaid connection operation is wrapped (AC2)', () => {
    const offLimits = [...wrapped].filter((o) =>
      /\/api\/imports\/(upload|detect-adapter)$/.test(o) ||
      (o.includes('/api/plaid/') && !o.includes('/api/plaid/transactions')));
    expect(offLimits).toEqual([]);
    expect(ALL_TOOLS.map((t) => t.name)).not.toEqual(expect.arrayContaining(['import_file']));
    for (const name of ['import_file', 'get_sync_status', 'update_bank_connection']) {
      expect(ALL_TOOLS.some((t) => t.name === name)).toBe(false);
    }
  });
});
