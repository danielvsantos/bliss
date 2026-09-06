import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AddBankDialog } from './add-bank-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe('AddBankDialog', () => {
  let onOpenChange: ReturnType<typeof vi.fn>;
  let onConfirm: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onOpenChange = vi.fn();
    onConfirm = vi.fn().mockResolvedValue(undefined);
  });

  function renderDialog(isSubmitting = false) {
    return render(
      <AddBankDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        isSubmitting={isSubmitting}
      />
    );
  }

  it('does not call onConfirm and shows a validation message for a name under 2 characters', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('addBankDialog.nameLabel'), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(screen.getByText('addBankDialog.validationError')).toBeInTheDocument();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not call onConfirm and shows a validation message for a name over 100 characters', async () => {
    renderDialog();
    const longName = 'a'.repeat(101);
    fireEvent.change(screen.getByLabelText('addBankDialog.nameLabel'), { target: { value: longName } });
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(screen.getByText('addBankDialog.validationError')).toBeInTheDocument();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onConfirm with the trimmed name for a valid entry', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('addBankDialog.nameLabel'), { target: { value: '  Monzo  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith('Monzo');
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('pressing Enter in the input triggers confirm exactly once', async () => {
    renderDialog();
    const input = screen.getByLabelText('addBankDialog.nameLabel');
    fireEvent.change(input, { target: { value: 'Chase' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith('Chase');
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons and shows the saving label while isSubmitting', () => {
    renderDialog(true);
    expect(screen.getByRole('button', { name: 'common.saving' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeDisabled();
  });

  it('cancel calls onOpenChange(false) without calling onConfirm', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
