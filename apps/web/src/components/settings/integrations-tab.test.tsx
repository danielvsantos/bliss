import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { IntegrationsTab, TokenReveal } from './integrations-tab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

// Radix RadioGroup measures its items; jsdom has no ResizeObserver.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mockToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

const T = 'pages.settings.integrations';
const TOKEN = 'bliss_AbCdEfGh_0123456789abcdefghijABCDEFGHIJklmnopqrstu';

const KEY = {
  id: 'key-1',
  name: 'Default key',
  prefix: 'AbCdEfGh',
  expiresAt: '2027-01-01T00:00:00.000Z',
  lastUsedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  revokedAt: null,
  status: 'active',
};

const INTEGRATION = {
  id: 'int-1',
  name: 'Claude agent',
  description: 'Reads my data',
  accessLevel: 'READ_ONLY',
  createdByUserId: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  revokedAt: null,
  status: 'active',
  keyCount: 1,
  activeKeyCount: 1,
  lastUsedAt: null,
  keys: [KEY],
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntegrationsTab />
    </QueryClientProvider>,
  );
}

function listReturns(integrations: unknown[]) {
  server.use(http.get('/api/integrations', () => HttpResponse.json({ integrations })));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('IntegrationsTab', () => {
  it('shows the empty state', async () => {
    listReturns([]);
    renderTab();
    expect(await screen.findByText(`${T}.empty`)).toBeInTheDocument();
    expect(screen.getByText(`${T}.security_note`)).toBeInTheDocument();
  });

  it('shows an error state', async () => {
    server.use(http.get('/api/integrations', () => HttpResponse.json({ error: 'x' }, { status: 500 })));
    renderTab();
    expect(await screen.findByText(`${T}.loading_error`)).toBeInTheDocument();
  });

  it('lists integrations with access level, status and keys (prefix only)', async () => {
    listReturns([
      INTEGRATION,
      { ...INTEGRATION, id: 'int-2', name: 'n8n', accessLevel: 'READ_WRITE', status: 'revoked', revokedAt: '2026-10-02T00:00:00.000Z' },
    ]);
    const user = userEvent.setup();
    renderTab();

    const rows = await screen.findAllByTestId('integration-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Claude agent')).toBeInTheDocument();
    expect(within(rows[0]).getByText(`${T}.access_read_only`)).toBeInTheDocument();
    expect(within(rows[0]).getByText(`${T}.status_active`)).toBeInTheDocument();
    expect(within(rows[1]).getByText(`${T}.access_read_write`)).toBeInTheDocument();
    expect(within(rows[1]).getByText(`${T}.status_revoked`)).toBeInTheDocument();
    // Revoked integrations have no add/revoke actions.
    expect(within(rows[1]).queryByText(`${T}.add_key`)).not.toBeInTheDocument();

    await user.click(within(rows[0]).getByText(`${T}.show_keys`));
    const keyRow = within(rows[0]).getByTestId('api-key-row');
    expect(within(keyRow).getByText('bliss_AbCdEfGh_…')).toBeInTheDocument();
    expect(within(keyRow).getByText(`${T}.revoke_key`)).toBeInTheDocument();
  });

  it('creates an integration and reveals the token exactly once', async () => {
    listReturns([]);
    let posted: unknown;
    server.use(
      http.post('/api/integrations', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ integration: INTEGRATION, apiKey: KEY, token: TOKEN }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByText(`${T}.create`));
    await user.type(screen.getByLabelText(`${T}.form.name_label`), 'Claude agent');
    await user.click(screen.getByRole('radio', { name: new RegExp(`^${T}.access_read_write`) }));
    await user.click(screen.getByLabelText(`${T}.form.expiry_never`));
    expect(screen.getByText(`${T}.form.no_expiry_warning`)).toBeInTheDocument();
    await user.click(screen.getByText(`${T}.form.create_submit`));

    const reveal = await screen.findByTestId('token-reveal');
    expect(posted).toEqual({
      name: 'Claude agent',
      accessLevel: 'READ_WRITE',
      key: { expiresInDays: null },
    });
    expect(within(reveal).getByDisplayValue(TOKEN)).toBeInTheDocument();
    expect(within(reveal).getByText(`${T}.reveal.warning`)).toBeInTheDocument();
    expect(reveal.textContent).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(reveal.textContent).toContain('/api/transactions');
    expect(within(reveal).getByTestId('mcp-snippet').textContent).toContain('/api/mcp');

    await user.click(within(reveal).getByText(`${T}.reveal.done`));
    await waitFor(() => expect(screen.queryByTestId('token-reveal')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(TOKEN.slice(15));
    expect(document.body.innerHTML).not.toContain(TOKEN.slice(15));

    // Reopening starts from a clean form, never the old token.
    await user.click(screen.getByText(`${T}.create`));
    expect(screen.queryByTestId('token-reveal')).not.toBeInTheDocument();
    expect(screen.getByLabelText(`${T}.form.name_label`)).toHaveValue('');
  });

  it('requires a name', async () => {
    listReturns([]);
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByText(`${T}.create`));
    await user.click(screen.getByText(`${T}.form.create_submit`));
    expect(screen.getByText(`${T}.form.name_required`)).toBeInTheDocument();
  });

  it('shows an error toast when creation fails', async () => {
    listReturns([]);
    server.use(http.post('/api/integrations', () => HttpResponse.json({ error: 'nope' }, { status: 400 })));
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByText(`${T}.create`));
    await user.type(screen.getByLabelText(`${T}.form.name_label`), 'x');
    await user.click(screen.getByText(`${T}.form.create_submit`));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
    expect(screen.queryByTestId('token-reveal')).not.toBeInTheDocument();
  });

  it('adds a key and reveals its token', async () => {
    listReturns([INTEGRATION]);
    let posted: unknown;
    server.use(
      http.post('/api/integrations/int-1/keys', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ apiKey: KEY, token: TOKEN }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByText(`${T}.add_key`));
    await user.type(screen.getByLabelText(`${T}.form.key_name_label`), 'CI');
    await user.click(screen.getByLabelText(`${T}.form.expiry_30`));
    await user.click(screen.getByText(`${T}.form.add_key_submit`));
    const reveal = await screen.findByTestId('token-reveal');
    expect(posted).toEqual({ name: 'CI', expiresInDays: 30 });
    expect(within(reveal).getByDisplayValue(TOKEN)).toBeInTheDocument();
  });

  it('revokes a key after confirmation', async () => {
    listReturns([INTEGRATION]);
    let revoked = false;
    server.use(
      http.delete('/api/integrations/int-1/keys/key-1', () => {
        revoked = true;
        return HttpResponse.json({ apiKey: { ...KEY, status: 'revoked' } });
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByText(`${T}.show_keys`));
    await user.click(screen.getByText(`${T}.revoke_key`));
    expect(screen.getByText(`${T}.confirm.revoke_key_title`)).toBeInTheDocument();
    await user.click(screen.getByText(`${T}.confirm.confirm_revoke`));
    await waitFor(() => expect(revoked).toBe(true));
    expect(mockToast).toHaveBeenCalledWith({ title: `${T}.toast.key_revoked` });
  });

  it('revokes an integration after confirmation, and cancelling does nothing', async () => {
    listReturns([INTEGRATION]);
    let revoked = 0;
    server.use(
      http.delete('/api/integrations/int-1', () => {
        revoked += 1;
        return HttpResponse.json({ integration: { ...INTEGRATION, status: 'revoked' } });
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByLabelText(`${T}.revoke_integration`));
    await user.click(screen.getByText(`${T}.form.cancel`));
    expect(revoked).toBe(0);

    await user.click(screen.getByLabelText(`${T}.revoke_integration`));
    expect(screen.getByText(`${T}.confirm.revoke_integration_title`)).toBeInTheDocument();
    await user.click(screen.getByText(`${T}.confirm.confirm_revoke`));
    await waitFor(() => expect(revoked).toBe(1));
  });

  it('renames an integration', async () => {
    listReturns([INTEGRATION]);
    let patched: unknown;
    server.use(
      http.patch('/api/integrations/int-1', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json({ integration: { ...INTEGRATION, name: 'Renamed' } });
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByLabelText(`${T}.rename`));
    const input = screen.getByLabelText(`${T}.form.name_label`);
    expect(input).toHaveValue('Claude agent');
    await user.clear(input);
    await user.type(input, 'Renamed');
    await user.click(screen.getByText(`${T}.form.save`));
    await waitFor(() => expect(patched).toEqual({ name: 'Renamed', description: 'Reads my data' }));
  });
});

describe('TokenReveal — MCP snippet (#89)', () => {
  it('shows the MCP URL and copies a one-line claude mcp add command', async () => {
    const user = userEvent.setup();
    render(<TokenReveal token={TOKEN} onDone={vi.fn()} />);
    const snippet = screen.getByTestId('mcp-snippet');
    expect(within(snippet).getByText(`${T}.mcp.title`)).toBeInTheDocument();
    expect(within(snippet).getByText(`${T}.mcp.description`)).toBeInTheDocument();
    expect(snippet.textContent).toMatch(/https?:\/\/[^ ]+\/api\/mcp/);
    expect(snippet.textContent).toContain(`--header "Authorization: Bearer ${TOKEN}"`);

    await user.click(within(snippet).getByRole('button', { name: `${T}.mcp.copy_command` }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toMatch(new RegExp(`^claude mcp add --transport http bliss \\S+/api/mcp --header "Authorization: Bearer ${TOKEN}"$`));
    expect(await within(snippet).findByText(`${T}.reveal.copied`)).toBeInTheDocument();
  });
});

