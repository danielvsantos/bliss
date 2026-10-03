import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const signupModeKeys = {
  all: ['signup-mode'] as const,
};

/**
 * Whether this instance only accepts invited emails (#99), from the public
 * `GET /api/auth/signup-mode` flag.
 *
 * Purely informational: the server enforces the gate. On any failure the
 * auth page falls back to the open-mode UI rather than blocking sign-up.
 */
export function useSignupMode(): { inviteOnly: boolean } {
  const { data } = useQuery({
    queryKey: signupModeKeys.all,
    queryFn: () => api.getSignupMode(),
    staleTime: 60_000,
    retry: 1,
  });
  return { inviteOnly: data?.inviteOnly === true };
}
