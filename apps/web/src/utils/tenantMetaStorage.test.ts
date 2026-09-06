import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getTenantMeta,
  setTenantMeta,
  clearTenantMeta,
  pickTenantMetaFields,
  updateTenantMetaFromAPI,
} from './tenantMetaStorage';
import api from '@/lib/api';
import type { Tenant } from '@/types/api';

vi.mock('@/lib/api');

const tenant: Tenant = {
  id: 't1',
  name: 'Tenant',
  plan: 'free',
  createdAt: '2026-01-01',
  countries: [{ id: 'US', name: 'United States' }],
  currencies: [{ id: 'USD', name: 'US Dollar', symbol: '$' }],
  banks: [{ id: 1, name: 'Chase' }],
  transactionYears: [2026],
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTenantMeta();
});

describe('updateTenantMetaFromAPI', () => {
  it('refreshes and persists tenant metadata on success', async () => {
    vi.mocked(api.getTenant).mockResolvedValue(tenant);

    const meta = await updateTenantMetaFromAPI('t1');

    expect(meta).toEqual(pickTenantMetaFields(tenant));
    expect(getTenantMeta()).toEqual(pickTenantMetaFields(tenant));
  });

  it('keeps the previously cached tenantMeta when the refresh fails (e.g. rate limit, network blip)', async () => {
    setTenantMeta(pickTenantMetaFields(tenant));
    vi.mocked(api.getTenant).mockRejectedValue(new Error('429 Too Many Requests'));

    const result = await updateTenantMetaFromAPI('t1');

    expect(result).toBeNull();
    expect(getTenantMeta()).toEqual(pickTenantMetaFields(tenant));
  });

  it('returns null without touching the cache when called without a tenantId', async () => {
    setTenantMeta(pickTenantMetaFields(tenant));

    const result = await updateTenantMetaFromAPI('');

    expect(result).toBeNull();
    expect(api.getTenant).not.toHaveBeenCalled();
    expect(getTenantMeta()).toEqual(pickTenantMetaFields(tenant));
  });
});
