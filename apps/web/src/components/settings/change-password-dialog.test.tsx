import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { ChangePasswordDialog } from './change-password-dialog';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Mock useToast
const mockToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDialog(open = true, onOpenChange = vi.fn()) {
  return {
    onOpenChange,
    ...render(
      <ChangePasswordDialog open={open} onOpenChange={onOpenChange} />
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChangePasswordDialog', () => {
  it('does not render content when open is false', () => {
    renderDialog(false);
    expect(screen.queryByText('changePassword.title')).not.toBeInTheDocument();
  });

  it('renders all fields and buttons when open', () => {
    renderDialog();
    expect(screen.getByText('changePassword.title')).toBeInTheDocument();
    expect(screen.getByLabelText('changePassword.currentPassword')).toBeInTheDocument();
    expect(screen.getByLabelText('changePassword.newPassword')).toBeInTheDocument();
    expect(screen.getByLabelText('changePassword.confirmPassword')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /changePassword\.updatePassword/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /common\.cancel/i })).toBeInTheDocument();
  });

  it('shows validation error when passwords do not match', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('changePassword.currentPassword'), 'OldPassword1');
    await user.type(screen.getByLabelText('changePassword.newPassword'), 'NewPassword1');
    await user.type(screen.getByLabelText('changePassword.confirmPassword'), 'Different1');
    await user.click(screen.getByRole('button', { name: /changePassword\.updatePassword/i }));

    expect(screen.getByText('changePassword.mismatch')).toBeInTheDocument();
  });

  it('shows validation error when new password is too short', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('changePassword.currentPassword'), 'OldPassword1');
    await user.type(screen.getByLabelText('changePassword.newPassword'), 'short');
    await user.type(screen.getByLabelText('changePassword.confirmPassword'), 'short');
    await user.click(screen.getByRole('button', { name: /changePassword\.updatePassword/i }));

    expect(screen.getByText('changePassword.newPasswordMin')).toBeInTheDocument();
  });

  it('calls the API on valid submit and shows success toast', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.put('/api/auth/change-password', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ message: 'Password updated successfully' });
      })
    );

    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(true, onOpenChange);

    await user.type(screen.getByLabelText('changePassword.currentPassword'), 'OldPassword1');
    await user.type(screen.getByLabelText('changePassword.newPassword'), 'NewPassword1');
    await user.type(screen.getByLabelText('changePassword.confirmPassword'), 'NewPassword1');
    await user.click(screen.getByRole('button', { name: /changePassword\.updatePassword/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'changePassword.passwordUpdated' })
      );
    });

    expect(capturedBody).toEqual({
      currentPassword: 'OldPassword1',
      newPassword: 'NewPassword1',
      confirmPassword: 'NewPassword1',
    });
  });

  it('shows error toast on 401 response (wrong current password)', async () => {
    server.use(
      http.put('/api/auth/change-password', () =>
        HttpResponse.json({ error: 'Current password is incorrect' }, { status: 401 })
      )
    );

    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('changePassword.currentPassword'), 'WrongPassword');
    await user.type(screen.getByLabelText('changePassword.newPassword'), 'NewPassword1');
    await user.type(screen.getByLabelText('changePassword.confirmPassword'), 'NewPassword1');
    await user.click(screen.getByRole('button', { name: /changePassword\.updatePassword/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'common.error',
          variant: 'destructive',
        })
      );
    });
  });
});
