// ─── activityMap.test.js ────────────────────────────────────────────────────
// The job → activity map for processing status (#100): which jobs a tenant
// sees, under which type / stage, and which pages their chain affects.

const { resolveActivity } = require('../../../config/activityMap');

const job = (name, data = {}) => ({ name, data: { tenantId: 't1', ...data } });

describe('resolveActivity', () => {
  it('never tracks a job without a tenantId', () => {
    expect(resolveActivity('portfolio', { name: 'revalue-all-tenants', data: {} })).toBeNull();
    expect(resolveActivity('insights', { name: 'generate-all-insights', data: {} })).toBeNull();
    expect(resolveActivity('portfolio', { name: 'value-all-assets' })).toBeNull();
  });

  it('never tracks unknown queues or names', () => {
    expect(resolveActivity('nope', job('x'))).toBeNull();
    expect(resolveActivity('events', job('UNKNOWN_EVENT'))).toBeNull();
    expect(resolveActivity('security-master', job('refresh-all-fundamentals'))).toBeNull();
    expect(resolveActivity('subscription-detection', job('detect-all-tenants'))).toBeNull();
  });

  it('maps a simple-transaction edit chain onto pages it will change (D3)', () => {
    // The first hop is the cash stage on the portfolio queue, but Expenses
    // (analytics) must already light up.
    expect(resolveActivity('events', job('MANUAL_TRANSACTION_MODIFIED'))).toMatchObject({
      type: 'PORTFOLIO_UPDATE', stage: 'scheduling', affects: ['PORTFOLIO_UPDATE', 'ANALYTICS_UPDATE'], ephemeral: true,
    });
    expect(resolveActivity('portfolio', job('process-cash-holdings'))).toMatchObject({
      type: 'PORTFOLIO_UPDATE', stage: 'updating_cash', affects: ['PORTFOLIO_UPDATE', 'ANALYTICS_UPDATE'],
    });
    expect(resolveActivity('events', job('CASH_HOLDINGS_PROCESSED'))).toMatchObject({ type: 'ANALYTICS_UPDATE' });
  });

  it('flags long-running work for the 60 min stall clock', () => {
    expect(resolveActivity('portfolio', job('process-portfolio-changes')).long).toBe(true);
    expect(resolveActivity('portfolio', job('process-portfolio-changes', { transactionId: 'x' })).long).toBe(false);
    expect(resolveActivity('portfolio', job('process-portfolio-changes', { accountIds: [1] })).long).toBe(false);
    expect(resolveActivity('portfolio', job('value-all-assets')).long).toBe(true);
    expect(resolveActivity('portfolio', job('value-portfolio-items')).long).toBe(false);
    expect(resolveActivity('analytics', job('full-rebuild-analytics')).long).toBe(true);
    expect(resolveActivity('analytics', job('scoped-update-analytics', { scopes: [{}] })).long).toBe(false);
  });

  it('analytics affects portfolio only when it chains into valuation', () => {
    expect(resolveActivity('analytics', job('full-rebuild-analytics')).affects).toEqual(['ANALYTICS_UPDATE', 'PORTFOLIO_UPDATE']);
    expect(resolveActivity('analytics', job('scoped-update-analytics', { scopes: [{}] })).affects).toEqual(['ANALYTICS_UPDATE']);
    expect(resolveActivity('analytics', job('scoped-update-analytics', { scopes: [{}], portfolioItemIds: [1] })).affects)
      .toEqual(['ANALYTICS_UPDATE', 'PORTFOLIO_UPDATE']);
    expect(resolveActivity('analytics', job('full-rebuild-analytics', { _rebuildMeta: { rebuildType: 'full-analytics' } })).affects)
      .toEqual(['ANALYTICS_UPDATE']);
    expect(resolveActivity('events', job('ANALYTICS_RECALCULATION_COMPLETE', { _rebuildMeta: { rebuildType: 'full-analytics' } })).type)
      .toBe('ANALYTICS_UPDATE');
    expect(resolveActivity('events', job('ANALYTICS_RECALCULATION_COMPLETE')).type).toBe('PORTFOLIO_UPDATE');
  });

  it('tag analytics is regular analytics (D1)', () => {
    expect(resolveActivity('events', job('TAG_ASSIGNMENT_MODIFIED'))).toMatchObject({ type: 'ANALYTICS_UPDATE', affects: ['ANALYTICS_UPDATE'] });
  });

  it.each([
    ['plaid-sync', 'plaid-sync-job', 'BANK_SYNC', 'fetching_bank'],
    ['plaid-processing', 'PLAID_SYNC_COMPLETE', 'BANK_SYNC', 'classifying'],
    ['smart-import', 'process-smart-import', 'IMPORT', 'processing_file'],
    ['smart-import', 'commit-smart-import', 'IMPORT', 'committing'],
    ['security-master', 'refresh-tenant-securities', 'SECURITY_DATA', 'refreshing_market_data'],
    ['security-master', 'refresh-single-symbol', 'SECURITY_DATA', 'refreshing_market_data'],
    ['subscription-detection', 'detect-tenant', 'SUBSCRIPTION_SCAN', 'scanning'],
    ['insights', 'generate-tenant-insights', 'INSIGHTS', 'generating_insights'],
    ['insights', 'generate-portfolio-intel', 'INSIGHTS', 'generating_insights'],
    ['portfolio', 'process-simple-liability', 'PORTFOLIO_UPDATE', 'updating_debts'],
    ['portfolio', 'recalculate-portfolio-items', 'PORTFOLIO_UPDATE', 'valuing_assets'],
  ])('%s / %s → %s (%s)', (queue, name, type, stage) => {
    expect(resolveActivity(queue, job(name))).toMatchObject({ type, stage });
  });

  it('maps admin rebuild scopes', () => {
    expect(resolveActivity('events', job('MANUAL_REBUILD_REQUESTED', { scope: 'full-portfolio' })).type).toBe('PORTFOLIO_UPDATE');
    expect(resolveActivity('events', job('MANUAL_REBUILD_REQUESTED', { scope: 'full-analytics' })).type).toBe('ANALYTICS_UPDATE');
    expect(resolveActivity('events', job('MANUAL_REBUILD_REQUESTED', { scope: 'security-data' })).type).toBe('SECURITY_DATA');
    expect(resolveActivity('events', job('MANUAL_REBUILD_REQUESTED', { scope: 'bogus' }))).toBeNull();
  });

  it('maps bank sync, import and scan events', () => {
    expect(resolveActivity('events', job('PLAID_SYNC_UPDATES')).type).toBe('BANK_SYNC');
    expect(resolveActivity('events', job('SMART_IMPORT_COMMIT')).affects).toEqual(['IMPORT', 'PORTFOLIO_UPDATE', 'ANALYTICS_UPDATE']);
    expect(resolveActivity('events', job('SMART_IMPORT_REQUESTED')).affects).toEqual(['IMPORT']);
    expect(resolveActivity('events', job('SUBSCRIPTION_DETECTION_REQUESTED')).type).toBe('SUBSCRIPTION_SCAN');
  });
});
