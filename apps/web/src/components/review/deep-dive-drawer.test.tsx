import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepDiveDrawer } from './deep-dive-drawer';
import * as UseTags from '@/hooks/use-tags';
import { mockQueryResult, mockMutationResult } from '@/test/mock-helpers';
import type { ReviewItem } from './types';
import type { Tag } from '@/types/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/hooks/use-tags');

// TagInput's own internals (Radix Popover + cmdk) are exercised by manual
// QA / the component's own usage on the Transactions page; here we stub it
// to a simple test double so the drawer's wiring (pre-fill, save payload)
// can be asserted without fighting portal/combobox internals.
vi.mock('@/components/entities/tag-input', () => ({
  TagInput: ({
    selectedTagIds,
    onChange,
  }: {
    selectedTagIds: number[];
    onChange: (ids: number[]) => void;
  }) => (
    <div data-testid="tag-input">
      <span data-testid="selected-tag-ids">{selectedTagIds.join(',')}</span>
      <button type="button" onClick={() => onChange([...selectedTagIds, 999])}>
        add-tag-999
      </button>
      <button
        type="button"
        onClick={() => onChange(selectedTagIds.filter((id) => id !== selectedTagIds[0]))}
      >
        remove-first
      </button>
    </div>
  ),
}));

const TAGS: Tag[] = [
  { id: 1, name: 'Japan 2026' },
  { id: 2, name: 'Business' },
];

const PLAID_ITEM: ReviewItem = {
  id: 'plaid-tx-1',
  source: 'plaid',
  date: '2026-03-01',
  merchant: 'Whole Foods',
  description: 'Whole Foods',
  amount: 50,
  currency: 'USD',
  status: 'ai-approved',
  category: 'Groceries',
  categoryId: 5,
  confidence: 0.9,
  classificationSource: 'LLM',
  classificationReasoning: null,
  plaidHint: null,
  accountName: 'Checking',
  requiresEnrichment: false,
  enrichmentType: null,
  promotionStatus: 'CLASSIFIED',
  originalPlaidTx: {
    id: 'plaid-tx-1',
    plaidItemId: 'item-1',
    plaidAccountId: 'plaid-acc-1',
    plaidTransactionId: 'ext-1',
    amount: 50,
    date: '2026-03-01',
    name: 'Whole Foods',
    pending: false,
    syncType: 'INITIAL',
    processed: true,
    promotionStatus: 'CLASSIFIED',
  } as ReviewItem['originalPlaidTx'],
};

const IMPORT_ITEM: ReviewItem = {
  id: 'row-1',
  source: 'import',
  date: '2026-03-02',
  merchant: 'Coffee Shop',
  description: 'Coffee Shop',
  amount: 8,
  currency: 'USD',
  status: 'ai-approved',
  category: 'Dining',
  categoryId: 6,
  confidence: 0.9,
  classificationSource: 'LLM',
  classificationReasoning: null,
  plaidHint: null,
  accountName: 'Checking',
  requiresEnrichment: false,
  enrichmentType: null,
  promotionStatus: 'PENDING',
  originalImportRow: {
    id: 'row-1',
    stagedImportId: 'import-1',
    rowNumber: 1,
    rawData: {},
    status: 'PENDING',
    accountId: 42, // avoids the drawer's "account required" save-block for this test
    tags: ['japan 2026'], // lowercase — pre-fill must match case-insensitively
  } as ReviewItem['originalImportRow'],
};

function renderDrawer(overrides: Partial<Parameters<typeof DeepDiveDrawer>[0]> = {}) {
  const onSaveAndPromote = vi.fn();
  const onClose = vi.fn();
  const onSkip = vi.fn();
  render(
    <DeepDiveDrawer
      item={PLAID_ITEM}
      categories={[]}
      onClose={onClose}
      onSaveAndPromote={onSaveAndPromote}
      onSkip={onSkip}
      {...overrides}
    />,
  );
  return { onSaveAndPromote, onClose, onSkip };
}

describe('DeepDiveDrawer — tags', () => {
  let createTagMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    createTagMock = vi.fn();
    vi.mocked(UseTags.useTags).mockReturnValue(mockQueryResult(TAGS));
    vi.mocked(UseTags.useCreateTag).mockReturnValue(
      mockMutationResult({ mutateAsync: createTagMock }),
    );
  });

  it('starts with an empty tag selection for a Plaid item', () => {
    renderDrawer({ item: PLAID_ITEM });
    expect(screen.getByTestId('selected-tag-ids').textContent).toBe('');
  });

  it('pre-fills tags from originalImportRow.tags, matching case-insensitively', () => {
    renderDrawer({ item: IMPORT_ITEM });
    expect(screen.getByTestId('selected-tag-ids').textContent).toBe('1');
  });

  it('eagerly creates a Tag for any CSV name with no existing match', async () => {
    createTagMock.mockResolvedValueOnce({ id: 3, name: 'New Project' });
    const itemWithNewTag: ReviewItem = {
      ...IMPORT_ITEM,
      originalImportRow: {
        ...IMPORT_ITEM.originalImportRow!,
        tags: ['New Project'],
      },
    };

    renderDrawer({ item: itemWithNewTag });

    await waitFor(() => expect(createTagMock).toHaveBeenCalledWith({ name: 'New Project' }));
    await waitFor(() =>
      expect(screen.getByTestId('selected-tag-ids').textContent).toBe('3'),
    );
  });

  it('includes tagNames reflecting current selection in the save payload', () => {
    const { onSaveAndPromote } = renderDrawer({ item: IMPORT_ITEM });

    // Pre-filled with "Japan 2026" (id 1); add tag id 999 is unresolvable
    // against TAGS, so it will be dropped from tagNames — simulate a real
    // add instead by adding an existing tag id via a second click sequence.
    fireEvent.click(screen.getByText('add-tag-999'));

    const saveButton = screen.getByRole('button', { name: 'review.saveAndPromote' });
    fireEvent.click(saveButton);

    expect(onSaveAndPromote).toHaveBeenCalledTimes(1);
    const payload = onSaveAndPromote.mock.calls[0][0];
    // id 999 doesn't match any known tag so it's excluded from names;
    // id 1 ("Japan 2026") remains from the pre-fill.
    expect(payload.tagNames).toEqual(['Japan 2026']);
  });

  it('removing the pre-filled tag results in an empty tagNames on save', () => {
    const { onSaveAndPromote } = renderDrawer({ item: IMPORT_ITEM });

    fireEvent.click(screen.getByText('remove-first'));

    const saveButton = screen.getByRole('button', { name: 'review.saveAndPromote' });
    fireEvent.click(saveButton);

    expect(onSaveAndPromote).toHaveBeenCalledTimes(1);
    const payload = onSaveAndPromote.mock.calls[0][0];
    expect(payload.tagNames).toEqual([]);
  });

  it('sends an empty tagNames array when no tags are selected', () => {
    const { onSaveAndPromote } = renderDrawer({ item: PLAID_ITEM });

    const saveButton = screen.getByRole('button', { name: 'review.saveAndPromote' });
    fireEvent.click(saveButton);

    expect(onSaveAndPromote).toHaveBeenCalledTimes(1);
    const payload = onSaveAndPromote.mock.calls[0][0];
    expect(payload.tagNames).toEqual([]);
  });
});

describe('DeepDiveDrawer — FAILED classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(UseTags.useTags).mockReturnValue(mockQueryResult(TAGS));
    vi.mocked(UseTags.useCreateTag).mockReturnValue(mockMutationResult());
  });

  const FAILED_ITEM: ReviewItem = {
    ...PLAID_ITEM,
    status: 'classification-failed',
    categoryId: null,
    promotionStatus: 'FAILED',
    originalPlaidTx: {
      ...PLAID_ITEM.originalPlaidTx!,
      promotionStatus: 'FAILED',
      processingError: 'Gemini classification timed out after 5000ms',
    } as ReviewItem['originalPlaidTx'],
  };

  it('shows humanized error text for a timeout, not the raw backend message', () => {
    renderDrawer({ item: FAILED_ITEM, onRetry: vi.fn() });

    expect(screen.getByText('review.errorTimedOut')).toBeInTheDocument();
    expect(screen.queryByText(/Gemini classification timed out/)).not.toBeInTheDocument();
  });

  it('falls back to the generic error key for an unrecognized message', () => {
    const item = {
      ...FAILED_ITEM,
      originalPlaidTx: { ...FAILED_ITEM.originalPlaidTx!, processingError: 'Some unexpected provider error' },
    } as ReviewItem;
    renderDrawer({ item, onRetry: vi.fn() });

    expect(screen.getByText('review.errorGeneric')).toBeInTheDocument();
  });

  it('calls onRetry when the retry button is clicked', () => {
    const onRetry = vi.fn();
    renderDrawer({ item: FAILED_ITEM, onRetry });

    fireEvent.click(screen.getByText('review.retryClassification'));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not render the failure banner for a non-FAILED item', () => {
    renderDrawer({ item: PLAID_ITEM, onRetry: vi.fn() });

    expect(screen.queryByText('review.retryClassification')).not.toBeInTheDocument();
  });
});
