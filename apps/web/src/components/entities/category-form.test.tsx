import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { CategoryForm } from './category-form';
import { api } from '@/lib/api';
import type { Category } from '@/types/api';

vi.mock('@/lib/api');
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/use-metadata', () => ({
  useCategories: () => ({ data: [] }),
}));

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

function renderForm(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const defaultCategory: Category = {
  id: 5,
  name: 'Software',
  group: 'Subscriptions',
  type: 'Lifestyle',
  tenantId: 't1',
  isRecurring: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.updateCategory).mockResolvedValue({ ...defaultCategory, isRecurring: true });
  vi.mocked(api.createCategory).mockResolvedValue({ ...defaultCategory, id: 9 });
});

describe('CategoryForm — recurring charge toggle', () => {
  it('rename mode: toggling "Recurring charge" sends isRecurring:true through updateCategory', async () => {
    renderForm(<CategoryForm category={defaultCategory} mode="rename" onClose={vi.fn()} />);

    expect(screen.getByText('categoryFormPage.recurringLabel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'ui.saveChanges' }));

    await waitFor(() => {
      expect(api.updateCategory).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ isRecurring: true }),
      );
    });
  });

  it('edit mode: preserves an already-on recurring flag on save', async () => {
    renderForm(
      <CategoryForm
        category={{ ...defaultCategory, id: 7, isRecurring: true }}
        mode="edit"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'ui.saveChanges' }));

    await waitFor(() => {
      expect(api.updateCategory).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ isRecurring: true }),
      );
    });
  });
});
