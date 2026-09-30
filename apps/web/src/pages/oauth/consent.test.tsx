import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { OAuthConsentPage } from './consent';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { email: 'admin@example.com' }, loading: false }) }));

// Radix RadioGroup measures its items; jsdom has no ResizeObserver.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const T = 'pages.oauth.consent';
const REQUEST = { id: 'req-1', clientName: 'Claude', redirectHost: 'claude.ai', maxAccessLevel: 'READ_WRITE', expiresAt: '2026-10-01T00:00:00Z' };

const assign = vi.fn();
const originalLocation = window.location;

function renderPage(search = '?request=req-1') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, search, assign },
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OAuthConsentPage />
    </QueryClientProvider>,
  );
}

function consentReturns(body: unknown, status = 200) {
  server.use(http.get('/api/oauth/requests/req-1', () => HttpResponse.json(body as object, { status })));
}

beforeEach(() => assign.mockReset());
afterEach(() => Object.defineProperty(window, 'location', { configurable: true, value: originalLocation }));

describe('OAuth consent page (#89)', () => {
  it('shows the app, the redirect host, and approves with the chosen access and expiry', async () => {
    consentReturns({ request: REQUEST, canApprove: true, expiryOptions: [30, 90, 365, null] });
    let posted: unknown;
    server.use(http.post('/api/oauth/requests/req-1/approve', async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({ redirectUrl: 'https://claude.ai/api/mcp/auth_callback?code=c&state=s' });
    }));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(`${T}.title {"client":"Claude"}`)).toBeInTheDocument();
    expect(screen.getByTestId('oauth-redirect-host').textContent).toContain('claude.ai');
    expect(screen.getByText(`${T}.signed_in_as {"email":"admin@example.com"}`)).toBeInTheDocument();
    // Read-only is the default even when the app may get more.
    expect(screen.getByRole('radio', { name: /access_read_only/ })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: /access_read_write/ }));
    await user.click(screen.getByRole('radio', { name: /form.expiry_365/ }));
    await user.click(screen.getByText(`${T}.allow`));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?code=c&state=s'));
    expect(posted).toEqual({ accessLevel: 'READ_WRITE', expiresInDays: 365 });
  });

  it('sends "never" as a null expiry and warns about it', async () => {
    consentReturns({ request: REQUEST, canApprove: true, expiryOptions: [] });
    let posted: unknown;
    server.use(http.post('/api/oauth/requests/req-1/approve', async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({ redirectUrl: 'https://claude.ai/cb' });
    }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('radio', { name: /form.expiry_never/ }));
    expect(screen.getByText(`${T}.no_expiry_warning`)).toBeInTheDocument();
    await user.click(screen.getByText(`${T}.allow`));
    await waitFor(() => expect(posted).toEqual({ accessLevel: 'READ_ONLY', expiresInDays: null }));
  });

  it('cannot grant write access when the app only asked to read', async () => {
    consentReturns({ request: { ...REQUEST, maxAccessLevel: 'READ_ONLY' }, canApprove: true, expiryOptions: [] });
    renderPage();
    expect(await screen.findByRole('radio', { name: /access_read_write/ })).toBeDisabled();
  });

  it('non-admins see why they cannot approve, and can still deny', async () => {
    consentReturns({ request: REQUEST, canApprove: false, expiryOptions: [] });
    server.use(http.post('/api/oauth/requests/req-1/deny', () => HttpResponse.json({ redirectUrl: 'https://claude.ai/cb?error=access_denied' })));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(`${T}.admin_required`)).toBeInTheDocument();
    expect(screen.queryByText(`${T}.allow`)).not.toBeInTheDocument();
    await user.click(screen.getByText(`${T}.deny`));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?error=access_denied'));
  });

  it('shows the server message for an expired or foreign request', async () => {
    consentReturns({ error: 'This connection request has expired. Start again from your app.' }, 410);
    renderPage();
    expect(await screen.findByText('This connection request has expired. Start again from your app.')).toBeInTheDocument();
    expect(screen.queryByText(`${T}.allow`)).not.toBeInTheDocument();
  });

  it('explains a link without a request id', async () => {
    renderPage('');
    expect(await screen.findByText(`${T}.error_missing`)).toBeInTheDocument();
  });

  it('keeps the page usable when approval fails', async () => {
    consentReturns({ request: REQUEST, canApprove: true, expiryOptions: [] });
    server.use(http.post('/api/oauth/requests/req-1/approve', () => HttpResponse.json({ error: 'This connection request is no longer valid' }, { status: 400 })));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText(`${T}.allow`));
    expect(await screen.findByText('This connection request is no longer valid')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByText(`${T}.allow`).closest('button')).not.toBeDisabled();
  });
});
