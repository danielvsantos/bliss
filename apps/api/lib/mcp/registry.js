import referenceTools from './tools/reference.js';
import transactionTools from './tools/transactions.js';
import analyticsTools from './tools/analytics.js';
import plaidTools from './tools/plaid.js';
import importTools from './tools/imports.js';
import portfolioTools from './tools/portfolio.js';
import subscriptionTools from './tools/subscriptions.js';

/**
 * The MCP tool catalogue (#89). Read tools are available to every key; write
 * tools only to Read & write keys (role `member`). tools/list is filtered by
 * role, and every write still goes through withAuth's viewer rule on its REST
 * route, so a read-only key cannot write even by calling a tool by name.
 */
export const ALL_TOOLS = Object.freeze([
  ...referenceTools,
  ...transactionTools,
  ...analyticsTools,
  ...plaidTools,
  ...importTools,
  ...portfolioTools,
  ...subscriptionTools,
]);

const seen = new Set();
for (const tool of ALL_TOOLS) {
  if (seen.has(tool.name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`);
  seen.add(tool.name);
}

export const READ_TOOLS = Object.freeze(ALL_TOOLS.filter((t) => t.access === 'read'));

/** @param {'viewer'|'member'|string} role */
export function toolsForRole(role) {
  return role === 'member' ? ALL_TOOLS : READ_TOOLS;
}

export function getTool(name) {
  return ALL_TOOLS.find((t) => t.name === name) ?? null;
}
