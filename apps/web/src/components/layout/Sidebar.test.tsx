import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { Sidebar } from './Sidebar';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const createQueryClient = () => new QueryClient({
  defaultOptions: { queries: { retry: false } }
});

describe('Sidebar Component', () => {
  it('renders primary navigation links', () => {
    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText('nav.dashboard')).toBeInTheDocument();
    expect(screen.getByText('nav.accounts')).toBeInTheDocument();
    expect(screen.getByText('nav.transactions')).toBeInTheDocument();
  });

  it('renders a badge with the correct total pending count', async () => {
    server.use(
      http.get('/api/plaid/transactions', () =>
        HttpResponse.json({ summary: { classified: 3 } })
      ),
      http.get('/api/imports/pending', () =>
        HttpResponse.json({ imports: [{ pendingRowCount: 2 }, { pendingRowCount: 4 }] })
      )
    );

    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // 3 (plaid) + 2 (import) + 4 (import) = 9
    await waitFor(() => {
      expect(screen.getByText('9')).toBeInTheDocument();
    });
  });

  it('handles zero pending gracefully', async () => {
    server.use(
      http.get('/api/plaid/transactions', () =>
        HttpResponse.json({ summary: { classified: 0 } })
      ),
      http.get('/api/imports/pending', () =>
        HttpResponse.json({ imports: [] })
      )
    );

    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Wait to ensure data returns and badge is NOT visible
    await waitFor(() => {
      const badge = screen.queryByText('0');
      expect(badge).not.toBeInTheDocument();
    });
  });
});
