import { z } from 'zod';
import { defineTool, currencyCode, intId, pathId } from '../define.js';
import { ToolInputError } from '../errors.js';
import { LoopbackError } from '../loopback.js';
import { shapeAccount } from './reference.js';

/**
 * Workspace setup (#98): create banks and manual accounts so an agent can map
 * what the user owns before importing. Create-only — renaming, deleting and
 * Plaid connections stay in the app (PUT/DELETE /api/accounts are denied to
 * integration keys). The REST routes own every rule: tenant ownership,
 * idempotency, the duplicate check and the owner default.
 */

const BANK_HINT = 'Call create_bank with the bank\'s name first — it links an existing bank without duplicating it.';

const createBank = defineTool({
  name: 'create_bank',
  access: 'write',
  title: 'Create bank',
  description:
    'Add a bank (or broker, card issuer…) to the user\'s workspace and return its ID for create_account. '
    + 'Idempotent: if a bank with this name already exists (any casing) it is reused and linked, never duplicated; '
    + '`created` is false when the workspace already had it. This is the way to get a bankId — the banks in '
    + 'get_reference_data are a global list that may include banks this workspace has not linked. '
    + 'Bank creation shares a budget of 10 requests per 5 minutes with bank listing: reuse IDs you already have '
    + '(from list_accounts or earlier calls) instead of calling this again.',
  input: {
    name: z.string().trim().min(2).max(100).describe('Bank name, e.g. "Revolut" (2-100 characters).'),
  },
  wraps: [{ method: 'POST', route: '/api/banks' }],
  async handler(args, { api }) {
    const { status, data } = await api.postWithStatus('/api/banks', { name: args.name });
    return { id: data.id, name: data.name, created: status === 201 };
  },
});

/** One-line, actionable message for the route's 400/409 answers (or null). */
function createAccountError(err, args) {
  if (!(err instanceof LoopbackError)) return null;

  if (err.status === 409 && err.code === 'ACCOUNT_EXISTS') {
    const id = err.details?.accountId;
    return `An account named '${args.name}' at bank ${args.bankId} (${args.currencyCode}) already exists`
      + `${id != null ? ` (id ${id})` : ''}. Use that id instead of creating it again.`;
  }

  if (err.status !== 400) return null;

  const details = err.details && typeof err.details === 'object' && !Array.isArray(err.details) ? err.details : null;
  if (details && (details.bankId || details.currency || details.country)) {
    const parts = [];
    if (details.bankId) parts.push(`Bank ${args.bankId} isn't linked to this workspace. ${BANK_HINT}`);
    if (details.currency) {
      parts.push(`Currency ${args.currencyCode} isn't enabled for this workspace — ask the user to enable it in Settings → Currencies.`);
    }
    if (details.country) {
      parts.push(`Country ${args.countryId} isn't enabled for this workspace — ask the user to enable it in Settings → Countries.`);
    }
    return parts.join(' ');
  }

  if (err.error === 'Invalid owner IDs') {
    return 'One or more ownerIds aren\'t users of this workspace. Omit ownerIds to make the connecting admin the owner.';
  }
  return null;
}

const createAccount = defineTool({
  name: 'create_account',
  access: 'write',
  title: 'Create account',
  description:
    'Create a manual account (bank, card, savings, brokerage…) in the user\'s workspace, then use its `id` as '
    + 'accountId when creating transactions or importing. Get bankId from create_bank. currencyCode and countryId '
    + 'must already be enabled for the workspace (get_reference_data → tenant lists them); if not, ask the user to '
    + 'enable them in Settings. Owners default to the admin who connected Bliss; other users can be added in the '
    + 'app. Safe to retry: a second account with the same bank, currency and name is refused with the existing '
    + 'account\'s id. Bank-synced (Plaid) accounts are connected in the app, not here.',
  input: {
    name: z.string().trim().min(1).max(100).describe('Account name, e.g. "Revolut EUR" (1-100 characters).'),
    bankId: intId('Bank ID from create_bank.'),
    currencyCode: currencyCode.describe('Account currency, 3-letter ISO 4217 code, e.g. EUR.'),
    countryId: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter uppercase ISO 3166 alpha-3 code, e.g. DEU')
      .describe('Account country, ISO 3166 alpha-3 code as listed by get_reference_data (e.g. DEU, USA, GBR).'),
    accountNumber: z.string().trim().min(1).max(64)
      .describe('Account number or IBAN. Stored encrypted and never shown back (only the last 4 characters) — '
        + 'use the last 4 digits or a short label if the user prefers not to share it.'),
    ownerIds: z.array(pathId()).min(1).max(10).optional()
      .describe('User IDs of the owners. Omit to make the connecting admin the owner.'),
  },
  wraps: [{ method: 'POST', route: '/api/accounts' }],
  async handler(args, { api }) {
    const body = {
      name: args.name,
      bankId: args.bankId,
      currencyCode: args.currencyCode,
      countryId: args.countryId,
      accountNumber: args.accountNumber,
      ...(args.ownerIds && { ownerIds: args.ownerIds }),
    };
    try {
      const account = await api.post('/api/accounts', body);
      return { account: shapeAccount(account) };
    } catch (err) {
      const message = createAccountError(err, args);
      if (message) throw new ToolInputError(message);
      throw err;
    }
  },
});

const TOOLS = [createBank, createAccount];

export default TOOLS;
