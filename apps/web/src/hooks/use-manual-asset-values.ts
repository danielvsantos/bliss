import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ManualAssetValue } from '@/types/api';

export const MANUAL_ASSET_VALUES_QUERY_KEY = 'manual-asset-values';

/**
 * Fetches the full manual-price history for a single portfolio item.
 * The API returns every `ManualAssetValue` row for the asset, newest first
 * (`date desc`). The query stays disabled until an `itemId` is supplied so the
 * hook can be mounted unconditionally by a controlled dialog.
 *
 * @param itemId - Portfolio item id. When `null`/`undefined` no request is made.
 */
export function useManualAssetValues(itemId?: number | null) {
  return useQuery<ManualAssetValue[]>({
    queryKey: [MANUAL_ASSET_VALUES_QUERY_KEY, itemId],
    queryFn: () => api.getManualAssetValues(itemId as number),
    enabled: itemId != null,
  });
}
