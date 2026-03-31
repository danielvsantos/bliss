import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Tag, TagRequest } from '@/types/api';

export const tagKeys = {
  all: ['tags'] as const,
  list: () => [...tagKeys.all, 'list'] as const,
};

export function useTags() {
  return useQuery({
    queryKey: tagKeys.list(),
    queryFn: async (): Promise<Tag[]> => {
      return api.getTags();
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useCreateTag() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: TagRequest): Promise<Tag> => {
      return api.createTag(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.all });
    },
  });
}

export function useUpdateTag() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<TagRequest> }): Promise<Tag> => {
      return api.updateTag(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.all });
    },
  });
}
