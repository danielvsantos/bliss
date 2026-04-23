/**
 * Unit tests for maybeReleaseRebuildLock.
 *
 * The helper fires on every BullMQ `completed` event across the portfolio
 * and analytics workers. It must release ONLY when:
 *   - the completed job carries `_rebuildMeta.rebuildType`, AND
 *   - the job name matches the terminal job mapped to that rebuildType.
 *
 * Any other completion — nightly crons, transaction-driven scoped updates,
 * intermediate steps of the full-portfolio chain that happen to complete
 * along the way — must NOT release.
 */

jest.mock('../../../utils/singleFlightLock', () => ({
  release: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { release } = require('../../../utils/singleFlightLock');
const { maybeReleaseRebuildLock } = require('../../../utils/rebuildLock');

const makeJob = (name, data) => ({ id: 'job-1', name, data });

describe('maybeReleaseRebuildLock', () => {
  beforeEach(() => jest.clearAllMocks());

  it('releases the full-portfolio lock when value-all-assets completes with matching meta', async () => {
    await maybeReleaseRebuildLock(
      makeJob('value-all-assets', {
        tenantId: 't1',
        _rebuildMeta: { rebuildType: 'full-portfolio' },
      }),
    );

    expect(release).toHaveBeenCalledWith('rebuild-lock:t1:full-portfolio');
  });

  it('releases the full-analytics lock when full-rebuild-analytics completes with matching meta', async () => {
    await maybeReleaseRebuildLock(
      makeJob('full-rebuild-analytics', {
        tenantId: 't1',
        _rebuildMeta: { rebuildType: 'full-analytics' },
      }),
    );

    expect(release).toHaveBeenCalledWith('rebuild-lock:t1:full-analytics');
  });

  it('releases the scoped-analytics lock when scoped-update-analytics completes with matching meta', async () => {
    await maybeReleaseRebuildLock(
      makeJob('scoped-update-analytics', {
        tenantId: 't1',
        _rebuildMeta: { rebuildType: 'scoped-analytics' },
      }),
    );

    expect(release).toHaveBeenCalledWith('rebuild-lock:t1:scoped-analytics');
  });

  it('releases the single-asset lock when value-portfolio-items completes with matching meta', async () => {
    await maybeReleaseRebuildLock(
      makeJob('value-portfolio-items', {
        tenantId: 't1',
        _rebuildMeta: { rebuildType: 'single-asset' },
      }),
    );

    expect(release).toHaveBeenCalledWith('rebuild-lock:t1:single-asset');
  });

  it('does NOT release when the job name does not match the terminal for the scope', async () => {
    // process-portfolio-changes is the FIRST step of full-portfolio, not
    // the terminal. It carries `_rebuildMeta` while the chain is still
    // running — releasing here would open the door to concurrent rebuilds
    // before the chain finishes.
    await maybeReleaseRebuildLock(
      makeJob('process-portfolio-changes', {
        tenantId: 't1',
        _rebuildMeta: { rebuildType: 'full-portfolio' },
      }),
    );

    expect(release).not.toHaveBeenCalled();
  });

  it('does NOT release when _rebuildMeta is absent (nightly crons, transaction events)', async () => {
    await maybeReleaseRebuildLock(
      makeJob('value-all-assets', { tenantId: 't1' }),
    );
    await maybeReleaseRebuildLock(
      makeJob('full-rebuild-analytics', { tenantId: 't1' }),
    );

    expect(release).not.toHaveBeenCalled();
  });

  it('does NOT release when rebuildType is unknown', async () => {
    await maybeReleaseRebuildLock(
      makeJob('value-all-assets', {
        tenantId: 't1',
        _rebuildMeta: { rebuildType: 'garbage' },
      }),
    );

    expect(release).not.toHaveBeenCalled();
  });

  it('does NOT release when tenantId is missing', async () => {
    await maybeReleaseRebuildLock(
      makeJob('value-all-assets', {
        _rebuildMeta: { rebuildType: 'full-portfolio' },
      }),
    );

    expect(release).not.toHaveBeenCalled();
  });

  it('swallows release errors and does not throw (TTL will eventually clear)', async () => {
    release.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      maybeReleaseRebuildLock(
        makeJob('value-all-assets', {
          tenantId: 't1',
          _rebuildMeta: { rebuildType: 'full-portfolio' },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('is a no-op on null / undefined / malformed jobs (defensive)', async () => {
    await maybeReleaseRebuildLock(null);
    await maybeReleaseRebuildLock(undefined);
    await maybeReleaseRebuildLock({});
    await maybeReleaseRebuildLock({ name: 'x' });
    await maybeReleaseRebuildLock({ name: 'x', data: null });

    expect(release).not.toHaveBeenCalled();
  });
});
