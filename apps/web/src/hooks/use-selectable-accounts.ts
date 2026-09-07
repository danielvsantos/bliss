import { useMemo } from 'react';
import { useAccounts } from '@/hooks/use-metadata';
import type { Account } from '@/types/api';

/**
 * Accounts a user can post/assign transactions to.
 *
 * Same data as `useAccounts()` but with onboarding-scaffolded **draft** accounts
 * filtered out — they carry a placeholder account number and no real balance
 * until confirmed via AccountForm, so they must not appear in the transaction
 * form, the transactions filter, or the Plaid review picker.
 *
 * Note: Smart Import deliberately keeps using `useAccounts()` (drafts included),
 * so the head start is usable for the CSV the user is about to import.
 */
export function useSelectableAccounts() {
  const query = useAccounts();

  const data = useMemo(
    () => query.data?.filter((a: Account) => !a.isDraft),
    [query.data],
  );

  return { ...query, data };
}
