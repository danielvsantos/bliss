import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import { useMetadata } from '@/hooks/use-metadata';
import { usePageVisible } from '@/hooks/use-page-visible';
import type { Account, Bank, PlaidItem } from '@/types/api';

// ─── Enriched Account Type ─────────────────────────────────────────────────
export interface EnrichedAccount {
  id: number;
  accountName: string;
  institution: string;       // Bank name
  bankId: number;
  mask: string;              // Last 4 digits masked (e.g., "•••• 1234")
  currencyCode: string;
  countryId: string;
  status: 'synced' | 'action-required' | 'disconnected' | 'manual';
  healthLabel: string;       // "Healthy" | "Action Required" | "Disconnected" | "Manual"
  healthColor: 'positive' | 'warning' | 'destructive' | 'muted';  // Design-system token names
  lastSync: string | null;
  plaidItem: PlaidItem | null;     // Linked PlaidItem (null for manual accounts)
  plaidAccountId: number | null;   // Specific Plaid sub-account id
  historicalSyncComplete: boolean;
  earliestTransactionDate: Date | null;
  originalAccount: Account;        // Reference to original Account object
}

// ─── Query Keys ────────────────────────────────────────────────────────────
export const accountListKeys = {
  all: ['account-list'] as const,
  plaidItems: () => ['plaid-items'] as const,
};

// ─── Hook ──────────────────────────────────────────────────────────────────
export function useAccountList() {
  const isVisible = usePageVisible();

  // Fetch manual accounts via metadata
  const { data: metadata, isLoading: metadataLoading, refetch: refetchMetadata } = useMetadata();

  // Fetch Plaid items — poll every 60s while any item has pending historical sync (paused when tab hidden)
  const {
    data: plaidItems,
    isLoading: plaidLoading,
    refetch: refetchPlaid,
  } = useQuery({
    queryKey: accountListKeys.plaidItems(),
    queryFn: () => api.getPlaidItems(),
    staleTime: 1000 * 60 * 2, // 2 minutes
    refetchInterval: (query) => {
      if (!isVisible) return false;
      const items = query.state.data;
      const hasIncomplete = items?.some(
        (item: PlaidItem) => item.status === 'ACTIVE' && !item.historicalSyncComplete
      );
      return hasIncomplete ? 60_000 : false;
    },
  });

  // Build enriched list
  const enrichedAccounts = useMemo(() => {
    if (!metadata?.accounts) return [];

    const banksById = new Map(metadata.banks.map((b: Bank) => [b.id, b]));

    // Index PlaidItems by their linked account IDs (not bankId) so that only
    // accounts explicitly linked during the Plaid sync-accounts flow get a
    // PlaidItem — avoids false "Synced" badges on unlinked accounts that
    // happen to share the same bank.
    const plaidItemByAccountId = new Map<number, PlaidItem>();
    if (plaidItems) {
      for (const pi of plaidItems) {
        if (pi.accounts) {
          for (const pa of pi.accounts) {
            plaidItemByAccountId.set(pa.id, pi);
          }
        }
      }
    }

    return metadata.accounts.map((acc: Account): EnrichedAccount => {
      const bank = banksById.get(acc.bankId);
      const plaidItem = plaidItemByAccountId.get(acc.id) ?? null;

      // Determine Plaid connection status
      let status: EnrichedAccount['status'] = 'manual';
      let healthLabel = 'Manual';
      let healthColor: EnrichedAccount['healthColor'] = 'muted';

      if (plaidItem) {
        if (plaidItem.status === 'ACTIVE') {
          status = 'synced';
          healthLabel = 'Healthy';
          healthColor = 'positive';
        } else if (plaidItem.status === 'REVOKED') {
          status = 'disconnected';
          healthLabel = 'Disconnected';
          healthColor = 'muted';
        } else if (plaidItem.status === 'LOGIN_REQUIRED') {
          status = 'action-required';
          healthLabel = 'Action Required';
          healthColor = 'warning';
        } else {
          // ERROR, PENDING_SELECTION, etc.
          status = 'action-required';
          healthLabel = 'Action Required';
          healthColor = 'destructive';
        }
      }

      // Mask account number
      const numStr = String(acc.accountNumber || '');
      const mask = numStr.length > 4 ? `•••• ${numStr.slice(-4)}` : numStr;

      return {
        id: acc.id,
        accountName: acc.name,
        institution: bank?.name ?? 'Unknown',
        bankId: acc.bankId,
        mask,
        currencyCode: acc.currencyCode,
        countryId: acc.countryId,
        status,
        healthLabel,
        healthColor,
        lastSync: plaidItem?.lastSync ?? null,
        plaidItem,
        plaidAccountId: null, // Will be matched if needed
        historicalSyncComplete: plaidItem?.historicalSyncComplete ?? true,
        earliestTransactionDate: plaidItem?.earliestTransactionDate
          ? new Date(plaidItem.earliestTransactionDate)
          : null,
        originalAccount: acc,
      };
    });
  }, [metadata, plaidItems]);

  const refetch = () => {
    refetchMetadata();
    refetchPlaid();
  };

  return {
    accounts: enrichedAccounts,
    plaidItems: plaidItems ?? [],
    isLoading: metadataLoading || plaidLoading,
    refetch,
  };
}
