import { ALL_TOOLS } from './registry.js';
import { EXCLUDED_OPERATIONS } from './exclusions.js';

/**
 * Markdown tool reference generated from the registry (#89), so the docs never
 * drift from the code. Written to docs/guides/mcp-tool-reference.md by
 * `pnpm --filter @bliss/api mcp:reference`; a unit test fails when the
 * committed file is stale.
 */

const DOMAINS = [
  ['Reference data', ['list_accounts', 'list_categories', 'get_reference_data', 'search_ticker', 'list_tags', 'manage_tags']],
  ['Workspace setup', ['create_bank', 'create_account']],
  ['Transactions', ['search_transactions', 'get_merchant_history', 'create_transaction', 'update_transaction', 'bulk_update_transactions', 'delete_transaction']],
  ['Analytics, insights & notifications', ['get_spending_summary', 'get_tag_summary', 'list_insights', 'generate_insights', 'dismiss_insight', 'get_notifications_summary', 'get_processing_status']],
  ['Bank-sync (Plaid) review queue', ['get_plaid_review_queue', 'review_plaid_transactions', 'requeue_plaid_transactions', 'list_plaid_seeds', 'confirm_plaid_seeds']],
  ['Smart Import review', ['list_imports', 'review_import_rows', 'list_import_seeds', 'confirm_import_seeds', 'finalize_import']],
  ['Portfolio & passive income', ['get_portfolio_holdings', 'get_portfolio_history', 'get_equity_analysis', 'get_passive_income', 'get_holding_details', 'set_asset_class', 'manage_manual_values', 'manage_income_and_debt_terms', 'manage_passive_income_streams']],
  ['Subscriptions', ['list_subscriptions', 'update_subscription']],
];

// Reads zod 4 internals (`_zod.def`): enough to label every field our tools use.
function unwrap(schema) {
  let s = schema;
  let optional = false;
  let nullable = false;
  for (;;) {
    const d = s?._zod?.def;
    if (d?.type === 'optional') { optional = true; s = d.innerType; continue; }
    if (d?.type === 'nullable') { nullable = true; s = d.innerType; continue; }
    if (d?.type === 'default') { optional = true; s = d.innerType; continue; }
    if (d?.type === 'pipe') { s = d.in; continue; }
    break;
  }
  return { inner: s, optional, nullable, description: schema.description ?? s?.description ?? '' };
}

function typeLabel(schema) {
  const { inner, nullable } = unwrap(schema);
  const d = inner?._zod?.def;
  let label;
  switch (d?.type) {
    case 'string': label = 'string'; break;
    case 'number': label = inner.isInt ? 'integer' : 'number'; break;
    case 'boolean': label = 'boolean'; break;
    case 'enum': label = inner.options.map((v) => `\`${v}\``).join(' | '); break;
    case 'literal': label = d.values.map((v) => `\`${v}\``).join(' | '); break;
    case 'union': label = d.options.map(typeLabel).join(' | '); break;
    case 'array': label = `array of ${typeLabel(d.element)}`; break;
    case 'object': label = `object { ${Object.keys(d.shape).join(', ')} }`; break;
    default: label = 'value';
  }
  return nullable ? `${label} | null` : label;
}

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function renderTool(tool) {
  const lines = [
    `### \`${tool.name}\` — ${tool.title}`,
    '',
    `**Access:** ${tool.access === 'read' ? 'Read (all keys)' : 'Write (Read & write keys only)'}${tool.annotations.destructiveHint ? ' · can delete or discard data' : ''}  `,
    `**Wraps:** ${tool.wraps.map((w) => `\`${w.method} ${w.route}\``).join(', ')}`,
    '',
    tool.description,
    '',
  ];
  const params = Object.entries(tool.input);
  if (params.length === 0) {
    lines.push('_No parameters._', '');
    return lines.join('\n');
  }
  lines.push('| Parameter | Type | Required | Description |', '|---|---|---|---|');
  for (const [name, schema] of params) {
    const { optional, description } = unwrap(schema);
    lines.push(`| \`${name}\` | ${cell(typeLabel(schema))} | ${optional ? 'no' : 'yes'} | ${cell(description)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderToolReference() {
  const listed = DOMAINS.flatMap(([, names]) => names);
  const unlisted = ALL_TOOLS.map((t) => t.name).filter((n) => !listed.includes(n));
  if (unlisted.length) throw new Error(`Add these tools to a DOMAINS section in lib/mcp/reference.js: ${unlisted.join(', ')}`);

  const reads = ALL_TOOLS.filter((t) => t.access === 'read').length;
  const out = [
    '# MCP Tool Reference',
    '',
    '<!-- Generated from apps/api/lib/mcp/registry.js by `pnpm --filter @bliss/api mcp:reference`. Do not edit by hand. -->',
    '',
    `Bliss exposes **${ALL_TOOLS.length} tools** over MCP at \`POST /api/mcp\`: **${reads} read** tools available to every integration key and **${ALL_TOOLS.length - reads} write** tools available only to *Read & write* keys. Setup: [Use Bliss with Claude (MCP)](/docs/guides/using-bliss-with-claude-mcp).`,
    '',
    'Conventions: dates are `YYYY-MM-DD`; amounts are `{ value, currency }`; transaction amounts are signed (positive = money in, negative = money out); lists return `hasMore` and `nextCursor` — pass `nextCursor` back as `cursor` for the next page (default 50 items, max 100).',
    '',
  ];
  for (const [domain, names] of DOMAINS) {
    out.push(`## ${domain}`, '');
    for (const name of names) out.push(renderTool(ALL_TOOLS.find((t) => t.name === name)));
  }
  out.push(
    '## Not available over MCP',
    '',
    'These REST operations are reachable with an integration key but have no tool, on purpose:',
    '',
    '| Operation | Why |',
    '|---|---|',
    ...EXCLUDED_OPERATIONS.map((e) => `| \`${e.method} ${e.route}\` | ${cell(e.reason)} |`),
    '| `POST /api/subscriptions` action `fullScan` | Maintenance (Settings → Maintenance) |',
    '',
  );
  return out.join('\n');
}
