import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CategoriesPage from './categories';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: any) => {
      if (opts?.type) return `${k} ${opts.type}`;
      if (opts?.name) return `${k} ${opts.name}`;
      return k;
    },
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/hooks/use-metadata', () => ({
  metadataKeys: { all: ['metadata'] },
}));

vi.mock('@/lib/api', () => {
  const mockApi = {
    getCategories: vi.fn().mockResolvedValue({ categories: [] }),
    deleteCategory: vi.fn(),
  };
  return { api: mockApi, default: mockApi };
});

// Mock CategoryForm to avoid deep component tree
vi.mock('@/components/entities/category-form', () => ({
  CategoryForm: () => <div data-testid="category-form" />,
}));

const renderPage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CategoriesPage />
    </QueryClientProvider>
  );
};

describe('CategoriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the categories page heading', () => {
    renderPage();
    expect(screen.getByText('nav.categories')).toBeInTheDocument();
    expect(screen.getByText('pages.categories.subtitle')).toBeInTheDocument();
  });

  it('shows loading skeleton initially', () => {
    // Override getCategories to never resolve (keep loading)
    const { api } = require('@/lib/api');
    api.getCategories.mockReturnValue(new Promise(() => {}));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <CategoriesPage />
      </QueryClientProvider>
    );

    // Loading skeleton uses animate-pulse class
    const skeleton = container.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();
  });

  it('renders add category button', () => {
    renderPage();
    expect(screen.getByText('pages.categories.addCategory')).toBeInTheDocument();
  });
});
