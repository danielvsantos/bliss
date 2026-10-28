import { describe, it, expect, vi } from 'vitest';

import { isRecentAuth, requireRecentAuth } from '../../../utils/recentAuth.js';

describe('recentAuth (#156)', () => {
  const now = new Date('2026-11-01T12:00:00Z');

  it('is recent within 15 minutes of the real sign-in', () => {
    expect(isRecentAuth({ authenticatedAt: new Date(now.getTime() - 5 * 60_000) }, now)).toBe(true);
    expect(isRecentAuth({ authenticatedAt: new Date(now.getTime() - 15 * 60_000) }, now)).toBe(true);
  });

  it('is not recent after 15 minutes, for legacy tokens, or without a user', () => {
    expect(isRecentAuth({ authenticatedAt: new Date(now.getTime() - 16 * 60_000) }, now)).toBe(false);
    expect(isRecentAuth({ authenticatedAt: null }, now)).toBe(false);
    expect(isRecentAuth(undefined, now)).toBe(false);
    expect(isRecentAuth({ authenticatedAt: new Date('invalid') }, now)).toBe(false);
  });

  it('requireRecentAuth answers 403 REAUTH_REQUIRED', () => {
    const res: any = { status: vi.fn(() => res), json: vi.fn(() => res) };
    expect(requireRecentAuth({ user: { authenticatedAt: null } } as any, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REAUTH_REQUIRED' }));

    const ok: any = { status: vi.fn() };
    expect(requireRecentAuth({ user: { authenticatedAt: new Date() } } as any, ok)).toBe(true);
    expect(ok.status).not.toHaveBeenCalled();
  });
});
