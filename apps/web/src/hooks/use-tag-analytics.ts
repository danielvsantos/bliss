import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { TagAnalyticsResponse } from '@/types/api';

export const TAG_ANALYTICS_QUERY_KEY = 'tag-analytics';

type TagAnalyticsFilters = {
  tagIds: number[];
  view: 'year' | 'quarter' | 'month';
  years?: number[];
  startMonth?: string;
  endMonth?: string;
  startQuarter?: string;
  endQuarter?: string;
  currency?: string;
};

export function useTagAnalytics(filters: TagAnalyticsFilters) {
  return useQuery<TagAnalyticsResponse, Error>({
    queryKey: [TAG_ANALYTICS_QUERY_KEY, filters],
    queryFn: () => api.getTagAnalytics(filters),
    enabled: filters.tagIds.length > 0 && !!filters.view,
  });
}
