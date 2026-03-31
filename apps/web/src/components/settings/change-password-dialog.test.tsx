import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { ChangePasswordDialog } from './change-password-dialog';

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
    expect(screen.queryByText('Change Password')).not.toBeInTheDocument();
  });

  it('renders all fields and buttons when open', () => {
    renderDialog();
    expect(screen.getByText('Change Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Current Password')).toBeInTheDocument();
    expect(screen.getByLabelText('New Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm New Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update password/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('shows validation error when passwords do not match', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('Current Password'), 'OldPassword1');
    await user.type(screen.getByLabelText('New Password'), 'NewPassword1');
    await user.type(screen.getByLabelText('Confirm New Password'), 'Different1');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
  });

  it('shows validation error when new password is too short', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('Current Password'), 'OldPassword1');
    await user.type(screen.getByLabelText('New Password'), 'short');
    await user.type(screen.getByLabelText('Confirm New Password'), 'short');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
  });

  it('calls the API on valid submit and shows success toast', async () => {
    let capturedBody: any = null;

    server.use(
      http.put('/api/auth/change-password', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ message: 'Password updated successfully' });
      })
    );

    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(true, onOpenChange);

    await user.type(screen.getByLabelText('Current Password'), 'OldPassword1');
    await user.type(screen.getByLabelText('New Password'), 'NewPassword1');
    await user.type(screen.getByLabelText('Confirm New Password'), 'NewPassword1');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Password updated' })
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

    await user.type(screen.getByLabelText('Current Password'), 'WrongPassword');
    await user.type(screen.getByLabelText('New Password'), 'NewPassword1');
    await user.type(screen.getByLabelText('Confirm New Password'), 'NewPassword1');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Error',
          variant: 'destructive',
        })
      );
    });
  });
});
