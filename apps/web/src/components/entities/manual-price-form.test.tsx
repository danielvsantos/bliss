import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManualPriceForm } from './manual-price-form';
import { api } from '@/lib/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/lib/api');

const renderForm = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ManualPriceForm asset={{ id: 7, symbol: 'PT-BOND-2030', currency: 'EUR' }} onClose={vi.fn()} />
    </QueryClientProvider>,
  );

describe('ManualPriceForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.createManualAssetValue).mockResolvedValue({} as never);
  });

  // Regression (#88): the price input used step="0.01", so the browser's native
  // constraint validation silently blocked submitting prices with more than two
  // decimals (typical bond quotes) before react-hook-form ever ran.
  it.each(['98.735', '101.0625', '0.000123'])('submits a price with more than two decimals (%s)', async (price) => {
    const user = userEvent.setup();
    renderForm();

    const input = screen.getByPlaceholderText('manualPriceForm.pricePlaceholder');
    await user.type(input, price);
    expect(input).toBeValid();
    await user.click(screen.getByRole('button', { name: 'manualPriceForm.savePrice' }));

    await waitFor(() => expect(api.createManualAssetValue).toHaveBeenCalledTimes(1));
    const [id, payload] = vi.mocked(api.createManualAssetValue).mock.calls[0];
    expect(id).toBe(7);
    expect(payload).toMatchObject({ value: Number(price), currency: 'EUR' });
  });
});
