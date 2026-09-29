import { useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  AssetClassInfo,
  ManageAssetsFilters,
  ManageAssetsResponse,
  ManagedAsset,
} from '@/types/manage-assets';
import type { DebtTerms } from '@/types/api';

/**
 * Manage Assets (#81) hooks.
 *
 * The list is filtered and paginated on the server; the page never loads
 * manual-value history. Each modal loads its own data through the hooks below
 * (or the existing income-terms / manual-values hooks).
 *
 * `invalidatePortfolioQueries()` and the Passive Income / asset class
 * mutations also invalidate {@link MANAGE_ASSETS_QUERY_KEY}.
 */
export const MANAGE_ASSETS_QUERY_KEY = 'portfolio-assets';
export const PAGE_SIZE = 50;

export const manageAssetsKeys = {
  all: [MANAGE_ASSETS_QUERY_KEY] as const,
  list: (filters: ManageAssetsFilters) => [MANAGE_ASSETS_QUERY_KEY, 'list', filters] as const,
  item: (id: number) => [MANAGE_ASSETS_QUERY_KEY, 'item', id] as const,
  debtTerms: (id: number) => [MANAGE_ASSETS_QUERY_KEY, 'debt-terms', id] as const,
  assetClass: (id: number) => [MANAGE_ASSETS_QUERY_KEY, 'asset-class', id] as const,
};

/** Drop empty values so equivalent filters share one cache entry. */
export function normalizeFilters(filters: ManageAssetsFilters): ManageAssetsFilters {
  const out: ManageAssetsFilters = {};
  if (filters.type) out.type = filters.type;
  if (filters.accountId != null) out.accountId = filters.accountId;
  if (filters.assetClass) out.assetClass = filters.assetClass;
  if (filters.search?.trim()) out.search = filters.search.trim();
  if (filters.status) out.status = filters.status;
  if (filters.includeClosed) out.includeClosed = true;
  return out;
}

export function useManageAssets(filters: ManageAssetsFilters) {
  const normalized = normalizeFilters(filters);
  return useInfiniteQuery<
    ManageAssetsResponse,
    Error,
    InfiniteData<ManageAssetsResponse>,
    ReturnType<typeof manageAssetsKeys.list>,
    string | null
  >({
    queryKey: manageAssetsKeys.list(normalized),
    queryFn: ({ pageParam }) => api.getManageAssets({ ...normalized, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * One row by id — from the loaded list when present, otherwise fetched on its
 * own (a deep link such as `/assets?item=12&modal=debt` can point past the
 * first page or outside the current filters).
 */
export function useManagedAsset(id: number | null, loaded: ManagedAsset[] | undefined) {
  const fromList = id != null ? loaded?.find((a) => a.id === id) : undefined;
  const query = useQuery({
    queryKey: manageAssetsKeys.item(id ?? 0),
    queryFn: async () => (await api.getManageAssets({ id: id as number, includeClosed: true })).items[0] ?? null,
    enabled: id != null && !fromList,
  });
  return {
    asset: fromList ?? query.data ?? null,
    isLoading: !fromList && query.isLoading && id != null,
    notFound: !fromList && query.isSuccess && query.data == null,
  };
}

export function useDebtTerms(assetId: number | null) {
  return useQuery<DebtTerms | null>({
    queryKey: manageAssetsKeys.debtTerms(assetId ?? 0),
    queryFn: () => api.getDebtTerms(assetId as number),
    enabled: assetId != null,
  });
}

export function useAssetClassInfo(assetId: number | null) {
  return useQuery<AssetClassInfo>({
    queryKey: manageAssetsKeys.assetClass(assetId ?? 0),
    queryFn: () => api.getAssetClass(assetId as number),
    enabled: assetId != null,
  });
}
