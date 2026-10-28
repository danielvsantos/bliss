import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { SignOutOthersDialog } from './sign-out-others-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const mockToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));

const T = 'pages.settings.general.sign_out_others';

let calls = 0;
let ok = true;
beforeEach(() => {
  vi.clearAllMocks();
  calls = 0;
  ok = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server.use(http.post('/api/auth/sessions/revoke-others', () => {
    calls += 1;
    return ok ? HttpResponse.json({ revoked: 2 }) : HttpResponse.json({ error: 'x' }, { status: 500 });
  }));
});

describe('SignOutOthersDialog (#156)', () => {
  it('signs out the other devices after confirmation and closes', async () => {
    const onOpenChange = vi.fn();
    render(<SignOutOthersDialog open onOpenChange={onOpenChange} />);

    await userEvent.click(screen.getByText(`${T}.confirm`));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls).toBe(1);
    expect(mockToast).toHaveBeenCalledWith({ title: `${T}.success` });
  });

  it('shows an error toast and stays open when it fails', async () => {
    ok = false;
    const onOpenChange = vi.fn();
    render(<SignOutOthersDialog open onOpenChange={onOpenChange} />);

    await userEvent.click(screen.getByText(`${T}.confirm`));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith({ title: `${T}.error`, variant: 'destructive' }));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('does nothing on cancel', async () => {
    const onOpenChange = vi.fn();
    render(<SignOutOthersDialog open onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByText('common.cancel'));
    expect(calls).toBe(0);
  });
});
