/**
 * Unit tests for `summarize()` from `@bliss/shared/activity` — the processing
 * status payload (#100). `packages/shared` has no test runner, so it's tested
 * here against the ESM build, like the portfolio module.
 *
 * Covers coalescing (AC2), the stall clocks (AC9 — display-only), expiry,
 * ordering, the recent cap and how a final failure colours the summary (AC8).
 */

import { describe, it, expect } from 'vitest';
import {
  summarize,
  unavailable,
  isStalled,
  activityKey,
  lastKey,
  STALL_THRESHOLDS_MS,
  RETENTION_MS,
  RECENT_LIMIT,
  FAILED_VISIBLE_MS,
  ACTIVITY_TYPE_LIST,
  TRIGGER_LIST,
} from '@bliss/shared/activity';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const MIN = 60_000;

const raw = (o: Record<string, unknown>) => JSON.stringify({
  t: 'PORTFOLIO_UPDATE', s: 'valuing_assets', st: 'running', p: null, tr: 'user_change', af: ['PORTFOLIO_UPDATE'],
  sa: NOW - 2 * MIN, ra: NOW - MIN, ua: NOW - 10_000, ...o,
});

describe('contract', () => {
  it('builds per-tenant keys', () => {
    expect(activityKey('t1')).toBe('activity:v1:t1');
    expect(lastKey('t1')).toBe('activity:v1:t1:last');
  });

  it('exposes the PRD types (minus TAG_ANALYTICS_UPDATE, D1) and triggers', () => {
    expect(ACTIVITY_TYPE_LIST).toEqual([
      'PORTFOLIO_UPDATE', 'ANALYTICS_UPDATE', 'BANK_SYNC', 'IMPORT', 'SECURITY_DATA', 'SUBSCRIPTION_SCAN', 'INSIGHTS',
    ]);
    expect(TRIGGER_LIST).toEqual(['user_change', 'bank_sync', 'import', 'nightly', 'manual_rebuild', 'agent']);
  });

  it('unavailable() is empty and says so', () => {
    expect(unavailable(NOW)).toEqual({
      available: false, workerOnline: null, serverTime: '2026-10-04T12:00:00.000Z', summary: {}, inFlight: [], recent: [], lastCompletedAt: {},
    });
  });
});

describe('summarize', () => {
  it('empty / missing hashes', () => {
    expect(summarize(null, null, true, NOW)).toMatchObject({ available: true, workerOnline: true, summary: {}, inFlight: [], recent: [] });
    expect(summarize({}, {}, null, NOW).workerOnline).toBeNull();
  });

  it('coalesces many jobs of one type into one summary row (AC2)', () => {
    const hash: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      hash[`portfolio:${i}`] = raw({ st: i < 3 ? 'running' : 'queued', sa: NOW - (20 - i) * 1000, ra: i < 3 ? NOW - (20 - i) * 1000 : undefined, p: i === 0 ? 30 : null });
    }
    hash['analytics:1'] = raw({ t: 'ANALYTICS_UPDATE', s: 'updating_analytics', af: ['ANALYTICS_UPDATE', 'PORTFOLIO_UPDATE'], sa: NOW - 5000, ra: NOW - 5000 });

    const out = summarize(hash, {}, true, NOW);
    expect(Object.keys(out.summary).sort()).toEqual(['ANALYTICS_UPDATE', 'PORTFOLIO_UPDATE']);
    expect(out.summary.PORTFOLIO_UPDATE).toMatchObject({ state: 'running', count: 10, progress: 30, stage: 'valuing_assets' });
    expect(out.summary.ANALYTICS_UPDATE.affects).toEqual(['ANALYTICS_UPDATE', 'PORTFOLIO_UPDATE']);
    expect(out.inFlight).toHaveLength(11);
    // Longest-running first.
    expect(out.inFlight[0].id).toBe('portfolio:0');
  });

  it('derives stalled on read with the default and the long clocks (AC9)', () => {
    const justUnder = NOW - STALL_THRESHOLDS_MS.default + 1000;
    const justOver = NOW - STALL_THRESHOLDS_MS.default - 1000;
    const longOver = NOW - STALL_THRESHOLDS_MS.long - 1000;
    const out = summarize({
      'a:1': raw({ ua: justUnder }),
      'a:2': raw({ ua: justOver }),
      'a:3': raw({ ua: justOver, lg: 1 }),                  // long job: still fine at 31 min
      'a:4': raw({ ua: longOver, lg: 1 }),                  // long job: stalled after 60 min
      'a:5': raw({ ua: justOver, t: 'SECURITY_DATA' }),     // security data uses the long clock
      'a:6': raw({ ua: justOver, st: 'queued', ra: undefined }), // queued uses the long clock
    }, {}, true, NOW);
    const state = Object.fromEntries(out.inFlight.map((e) => [e.id, e.state]));
    expect(state).toEqual({ 'a:1': 'running', 'a:2': 'stalled', 'a:3': 'running', 'a:4': 'stalled', 'a:5': 'running', 'a:6': 'queued' });
    expect(out.summary.PORTFOLIO_UPDATE.state).toBe('stalled');
    expect(isStalled({ t: 'PORTFOLIO_UPDATE', st: 'running', ua: justOver }, NOW)).toBe(true);
  });

  it('drops expired entries: in-flight orphans and history older than 24 h', () => {
    const out = summarize({
      'old:1': raw({ sa: NOW - RETENTION_MS - 1000, ua: NOW - RETENTION_MS - 1000 }),
      'old:2': raw({ st: 'completed', fa: NOW - RETENTION_MS - 1000 }),
      'ok:1': raw({ st: 'completed', fa: NOW - 1000 }),
    }, {}, true, NOW);
    expect(out.inFlight).toEqual([]);
    expect(out.recent.map((r) => r.id)).toEqual(['ok:1']);
  });

  it('orders recent newest first, caps it and computes durations', () => {
    const hash: Record<string, string> = {};
    for (let i = 0; i < RECENT_LIMIT + 20; i++) {
      hash[`p:${i}`] = raw({ st: 'completed', ra: NOW - 100_000, fa: NOW - 100_000 + 1000 + i });
    }
    const out = summarize(hash, {}, true, NOW);
    expect(out.recent).toHaveLength(RECENT_LIMIT);
    expect(out.recent[0].id).toBe(`p:${RECENT_LIMIT + 19}`);
    expect(out.recent[0].durationMs).toBe(1000 + RECENT_LIMIT + 19);
  });

  it('a recent final failure turns its type red until the type completes again (AC8)', () => {
    const failedAt = NOW - 5 * MIN;
    const base = { 'a:1': raw({ t: 'ANALYTICS_UPDATE', st: 'failed', ec: 'P2034', fa: failedAt }) };

    const red = summarize(base, {}, true, NOW);
    expect(red.summary.ANALYTICS_UPDATE).toMatchObject({ state: 'failed', errorCode: 'P2034', count: 0 });
    expect(red.recent[0]).toMatchObject({ state: 'failed', errorCode: 'P2034' });

    const recovered = summarize(base, { ANALYTICS_UPDATE: new Date(NOW - MIN).toISOString() }, true, NOW);
    expect(recovered.summary).toEqual({});

    const old = summarize({ 'a:1': raw({ t: 'ANALYTICS_UPDATE', st: 'failed', fa: NOW - FAILED_VISIBLE_MS - 1000 }) }, {}, true, NOW);
    expect(old.summary).toEqual({});

    const withRunning = summarize({ ...base, 'a:2': raw({ t: 'ANALYTICS_UPDATE' }) }, {}, true, NOW);
    expect(withRunning.summary.ANALYTICS_UPDATE).toMatchObject({ state: 'failed', count: 1 });
  });

  it('a failure without a code reports INTERNAL', () => {
    const out = summarize({ 'a:1': raw({ st: 'failed', fa: NOW - 1000 }) }, {}, true, NOW);
    expect(out.recent[0].errorCode).toBe('INTERNAL');
  });

  it('ignores malformed entries and unknown lastCompletedAt types', () => {
    const out = summarize({
      'bad:1': 'not json',
      'bad:2': JSON.stringify({ t: 'NOPE', st: 'running' }),
      'bad:3': JSON.stringify(null),
      'ok:1': raw({}),
    }, { PORTFOLIO_UPDATE: '2026-10-04T11:00:00.000Z', NOPE: '2026-10-04T11:00:00.000Z', ANALYTICS_UPDATE: 'garbage' }, true, NOW);
    expect(out.inFlight.map((e) => e.id)).toEqual(['ok:1']);
    expect(out.lastCompletedAt).toEqual({ PORTFOLIO_UPDATE: '2026-10-04T11:00:00.000Z' });
  });

  it('defaults affects to the entry type and filters unknown ones', () => {
    const out = summarize({ 'a:1': raw({ af: undefined }), 'a:2': raw({ af: ['ANALYTICS_UPDATE', 'EVIL'] }) }, {}, true, NOW);
    expect(out.inFlight.find((e) => e.id === 'a:1')!.affects).toEqual(['PORTFOLIO_UPDATE']);
    expect(out.inFlight.find((e) => e.id === 'a:2')!.affects).toEqual(['ANALYTICS_UPDATE']);
  });
});
