import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { useRecentAuth } from '@/hooks/use-recent-auth';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const signInWithGoogle = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ signInWithGoogle }) }));

// The installed app keeps Google Sign-In (#155 Phase 2), so the dialog never
// branches on standalone mode (#156 §0.1). Pinned: standalone is "true" here.
vi.mock('@/hooks/use-display-mode', () => ({ useIsStandalone: () => true }));

const T = 'pages.login.confirm_identity';

let status = { recent: false, methods: ['password', 'google'] };
let reauthPasswords: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  status = { recent: false, methods: ['password', 'google'] };
  reauthPasswords = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server.use(
    http.get('/api/auth/reauth', () => HttpResponse.json(status)),
    http.post('/api/auth/reauth', async ({ request }) => {
      const { password } = (await request.json()) as { password: string };
      reauthPasswords.push(password);
      return password === 'right'
        ? HttpResponse.json({ ok: true })
        : HttpResponse.json({ code: 'REAUTH_FAILED' }, { status: 401 });
    }),
  );
});

let hook: ReturnType<typeof useRecentAuth>;
function Harness({ returnTo }: { returnTo?: string }) {
  hook = useRecentAuth(returnTo);
  return <>{hook.dialog}</>;
}

describe('useRecentAuth + ConfirmIdentityDialog (#156)', () => {
  it('continues without a prompt when the last sign-in is recent', async () => {
    status = { recent: true, methods: ['password'] };
    render(<Harness />);
    await expect(hook.ensureRecentAuth()).resolves.toBe(true);
    expect(screen.queryByTestId('confirm-identity-dialog')).not.toBeInTheDocument();
  });

  it('shows the methods from the API, keeps the session on a wrong password, then confirms', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    let resolved: boolean | undefined;
    act(() => { void hook.ensureRecentAuth().then((v) => { resolved = v; }); });

    expect(await screen.findByText(`${T}.title`)).toBeInTheDocument();
    expect(screen.getByText(`${T}.google`)).toBeInTheDocument();

    await user.type(screen.getByLabelText(`${T}.password_label`), 'wrong');
    await user.click(screen.getByText(`${T}.confirm`));
    expect(await screen.findByText(`${T}.wrong_password`)).toBeInTheDocument();
    expect(resolved).toBeUndefined();

    await user.clear(screen.getByLabelText(`${T}.password_label`));
    await user.type(screen.getByLabelText(`${T}.password_label`), 'right');
    await user.click(screen.getByText(`${T}.confirm`));
    await waitFor(() => expect(resolved).toBe(true));
    expect(reauthPasswords).toEqual(['wrong', 'right']);
    await waitFor(() => expect(screen.queryByTestId('confirm-identity-dialog')).not.toBeInTheDocument());
  });

  it('starts the Google step-up back to the given page (the consent request)', async () => {
    const user = userEvent.setup();
    status = { recent: false, methods: ['google'] };
    render(<Harness returnTo="/oauth/consent?request=req-1" />);
    act(() => { void hook.ensureRecentAuth(); });

    await user.click(await screen.findByText(`${T}.google`));
    expect(signInWithGoogle).toHaveBeenCalledWith({ returnTo: '/oauth/consent?request=req-1', prompt: 'select_account' });
    expect(screen.queryByLabelText(`${T}.password_label`)).not.toBeInTheDocument();
  });

  it('resolves false when the user cancels', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    let resolved: boolean | undefined;
    act(() => { void hook.ensureRecentAuth().then((v) => { resolved = v; }); });

    await user.click(await screen.findByText('common.cancel'));
    await waitFor(() => expect(resolved).toBe(false));
  });

  it('withReauthRetry prompts on 403 REAUTH_REQUIRED and retries the action once', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const action = vi.fn()
      .mockRejectedValueOnce({ response: { status: 403, data: { code: 'REAUTH_REQUIRED' } } })
      .mockResolvedValueOnce('done');
    let result: unknown;
    act(() => { void hook.withReauthRetry(action).then((v) => { result = v; }); });

    await user.type(await screen.findByLabelText(`${T}.password_label`), 'right');
    await user.click(screen.getByText(`${T}.confirm`));
    await waitFor(() => expect(result).toBe('done'));
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('withReauthRetry rethrows other errors without prompting', async () => {
    render(<Harness />);
    const boom = new Error('boom');
    await expect(hook.withReauthRetry(() => Promise.reject(boom))).rejects.toBe(boom);
    expect(screen.queryByTestId('confirm-identity-dialog')).not.toBeInTheDocument();
  });

  it('explains when no method is available', async () => {
    status = { recent: false, methods: [] };
    render(<Harness />);
    act(() => { void hook.ensureRecentAuth(); });
    expect(await screen.findByText(`${T}.no_method`)).toBeInTheDocument();
  });
});
