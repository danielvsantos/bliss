import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AnalyticsResponse } from '@/types/api';

export const ANALYTICS_QUERY_KEY = 'analytics';

type AnalyticsFilters = {
    view: 'year' | 'quarter' | 'month';
    years?: number[];
    startMonth?: string;
    endMonth?: string;
    startQuarter?: string;
    endQuarter?: string;
    currency?: string;
    countries?: string[];
    types?: string[];
    groups?: string[];
};

export function useAnalytics(filters: AnalyticsFilters) {
  return useQuery<AnalyticsResponse, Error>({
    queryKey: [ANALYTICS_QUERY_KEY, filters],
    queryFn: () => api.getAnalytics(filters),
    enabled: !!filters.view && (!!filters.years?.length || !!filters.startMonth || !!filters.startQuarter),
  });
} 