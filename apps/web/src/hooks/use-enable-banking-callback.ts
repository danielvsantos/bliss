import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { accountListKeys } from '@/hooks/use-account-list';
import { plaidItemKeys } from '@/hooks/use-plaid-actions';

const KNOWN_ERRORS = new Set(['invalid_state', 'denied', 'exchange_failed', 'not_enabled']);
const CALLBACK_PARAMS = ['eb', 'eb_error', 'connection'];

/**
 * Handles the Enable Banking (#132) return from the bank on /accounts:
 *
 *   ?eb=map&connection=<id>          → opens the mapping dialog for <id>
 *   ?eb=reconnected&connection=<id>  → "Reconnected — syncing" toast
 *   ?eb_error=<code>                 → error toast for that code
 *
 * The params are stripped afterwards (history replace, no new entry).
 */
export function useEnableBankingCallback() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [mappingConnectionId, setMappingConnectionId] = useState<string | null>(null);
  const handled = useRef<string | null>(null);

  const eb = searchParams.get('eb');
  const ebError = searchParams.get('eb_error');
  const connection = searchParams.get('connection');

  useEffect(() => {
    if (!eb && !ebError) return;
    const signature = `${eb}|${ebError}|${connection}`;
    // Guard against a double run (StrictMode) before the URL update lands.
    if (handled.current !== signature) {
      handled.current = signature;
      if (ebError) {
        toast({
          title: t('enableBanking.callback.errorTitle'),
          description: t(`enableBanking.callback.${KNOWN_ERRORS.has(ebError) ? ebError : 'unknown'}`),
          variant: 'destructive',
        });
      } else if (eb === 'map' && connection) {
        setMappingConnectionId(connection);
      } else if (eb === 'reconnected') {
        toast({
          title: t('enableBanking.callback.reconnectedTitle'),
          description: t('enableBanking.callback.reconnectedDesc'),
        });
        queryClient.invalidateQueries({ queryKey: plaidItemKeys.all });
        queryClient.invalidateQueries({ queryKey: accountListKeys.all });
      }
    }

    const next = new URLSearchParams(searchParams);
    for (const key of CALLBACK_PARAMS) next.delete(key);
    setSearchParams(next, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t/toast change reference per render; only the callback params matter
  }, [eb, ebError, connection]);

  return {
    mappingConnectionId,
    openMapping: (id: string) => setMappingConnectionId(id),
    closeMapping: () => setMappingConnectionId(null),
  };
}
