import type { Tenant } from '@/types/api';
import api from '@/lib/api';

const TENANT_META_KEY = 'tenantMeta';

// Only store these fields
export function pickTenantMetaFields(tenant: Tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    plan: tenant.plan,
    createdAt: tenant.createdAt,
    countries: tenant.countries,
    currencies: tenant.currencies,
    banks: tenant.banks,
    transactionYears: tenant.transactionYears,
    plaidLinkedBankIds: tenant.plaidLinkedBankIds,
  };
}

export function getTenantMeta(): ReturnType<typeof pickTenantMetaFields> | null {
  const raw = localStorage.getItem(TENANT_META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setTenantMeta(meta: ReturnType<typeof pickTenantMetaFields>) {
  localStorage.setItem(TENANT_META_KEY, JSON.stringify(meta));
}

export function clearTenantMeta() {
  localStorage.removeItem(TENANT_META_KEY);
}

// Always fetch from API and update local storage
export async function updateTenantMetaFromAPI(tenantId: string) {
  if (!tenantId) {
    console.error("updateTenantMetaFromAPI called without a tenantId.");
    return null;
  }
  try {
    const tenant = await api.getTenant(tenantId);
    if (tenant) {
      const meta = pickTenantMetaFields(tenant);
      setTenantMeta(meta);
      return meta;
    } else {
      console.warn(`Tenant with ID ${tenantId} not found.`);
      clearTenantMeta();
    }
  } catch (error) {
    console.error(`Failed to fetch or update tenant metadata for tenantId: ${tenantId}`, error);
    // Optionally clear stale meta if the fetch fails
    clearTenantMeta();
    return null;
  }
  return null;
} 