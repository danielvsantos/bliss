/**
 * SIGNUP_MODE parsing (#99): open by default, fail closed on unknown values,
 * read per call (never cached), and the boot warning in validateEnv.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { getSignupMode, isInviteOnly, isUnknownSignupMode } from '../../../utils/signupMode.js';
import { validateEnv } from '../../../utils/validateEnv.js';

const saved = { SIGNUP_MODE: process.env.SIGNUP_MODE, ADMIN_API_KEY: process.env.ADMIN_API_KEY };

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe('getSignupMode / isInviteOnly', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['open', 'open'],
    ['OPEN with padding', ' OPEN '],
  ])('is open when SIGNUP_MODE is %s', (_label, value) => {
    if (value === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = value;

    expect(getSignupMode()).toBe('open');
    expect(isInviteOnly()).toBe(false);
    expect(isUnknownSignupMode()).toBe(false);
  });

  it.each([['invite_only'], [' Invite_Only ']])('is invite-only for %j', (value) => {
    process.env.SIGNUP_MODE = value;
    expect(getSignupMode()).toBe('invite_only');
    expect(isInviteOnly()).toBe(true);
    expect(isUnknownSignupMode()).toBe(false);
  });

  // A typo must lock sign-up, never silently leave it open.
  it.each([['invite-only'], ['closed'], ['true'], ['opn']])('fails closed for the unknown value %j', (value) => {
    process.env.SIGNUP_MODE = value;
    expect(getSignupMode()).toBe('invite_only');
    expect(isInviteOnly()).toBe(true);
    expect(isUnknownSignupMode()).toBe(true);
  });

  it('reads the variable on every call (toggle without restart)', () => {
    delete process.env.SIGNUP_MODE;
    expect(isInviteOnly()).toBe(false);
    process.env.SIGNUP_MODE = 'invite_only';
    expect(isInviteOnly()).toBe(true);
    process.env.SIGNUP_MODE = 'open';
    expect(isInviteOnly()).toBe(false);
  });
});

describe('validateEnv SIGNUP_MODE warnings', () => {
  function warnings() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateEnv();
    return warn.mock.calls.map((c) => String(c[0]));
  }

  it('warns that an unknown value is treated as invite_only', () => {
    process.env.SIGNUP_MODE = 'invite-only';
    process.env.ADMIN_API_KEY = 'k';
    const out = warnings();
    expect(out.some((w) => w.includes('SIGNUP_MODE="invite-only"') && w.includes('treated as invite_only'))).toBe(true);
  });

  it('warns when invite-only has no ADMIN_API_KEY to manage invites', () => {
    process.env.SIGNUP_MODE = 'invite_only';
    delete process.env.ADMIN_API_KEY;
    expect(warnings().some((w) => w.includes('ADMIN_API_KEY is not set'))).toBe(true);
  });

  it('says nothing about sign-up in open mode', () => {
    delete process.env.SIGNUP_MODE;
    delete process.env.ADMIN_API_KEY;
    expect(warnings().some((w) => w.includes('SIGNUP_MODE'))).toBe(false);
  });
});
