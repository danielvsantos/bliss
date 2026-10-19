import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Link } from 'react-router-dom';
import { AlertTriangle, Globe, Link as LinkIcon, ListChecks, PauseCircle, RefreshCw, Unlink } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import {
  enableBankingError,
  useConnectEnableBanking,
  useDisconnectEnableBankingConnection,
  useEnableBankingConnection,
  useSyncEnableBankingConnection,
} from '@/hooks/use-enable-banking';
import {
  countryName,
  formatBalance,
  formatDate,
  getConnectionState,
  type EnableBankingConnectionState,
} from '@/lib/enable-banking';
import type { PlaidItem } from '@/types/api';

interface BankConnectionCardProps {
  /** An Enable Banking connection (PlaidItem with provider ENABLE_BANKING). */
  item: PlaidItem;
  /** Opens the account mapping dialog for this connection. */
  onOpenMapping?: (connectionId: string) => void;
  onChanged?: () => void;
}

const STATUS_BADGE: Record<EnableBankingConnectionState, { className: string; key: string }> = {
  active: { className: 'bg-positive/10 text-positive border-positive/20 hover:bg-positive/10', key: 'enableBanking.card.statusActive' },
  expiring: { className: 'bg-warning/10 text-warning border-warning/20 hover:bg-warning/10', key: 'enableBanking.card.statusExpiring' },
  needsMapping: { className: 'bg-warning/10 text-warning border-warning/20 hover:bg-warning/10', key: 'enableBanking.card.statusNeedsMapping' },
  expired: { className: 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/10', key: 'enableBanking.card.statusExpired' },
  error: { className: 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/10', key: 'enableBanking.card.statusError' },
  disconnected: { className: 'bg-muted text-muted-foreground border-transparent hover:bg-muted', key: 'enableBanking.card.statusDisconnected' },
  paused: { className: 'bg-warning/10 text-warning border-warning/20 hover:bg-warning/10', key: 'enableBanking.card.statusPaused' },
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right">{children}</span>
    </div>
  );
}

/**
 * Status and actions for an Enable Banking connection (#132). Never offers a
 * Plaid action: Sync now, Reconnect (authorising user only), Map accounts and
 * Disconnect (admin or authorising user). A paused connection (#148: no
 * tenant credentials) offers no action: admins get a link to Bank sync.
 */
export function BankConnectionCard({ item, onOpenMapping, onChanged }: BankConnectionCardProps) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const { toast } = useToast();
  const { user } = useAuth();
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  const { data: details } = useEnableBankingConnection(item.id);
  const sync = useSyncEnableBankingConnection();
  const connect = useConnectEnableBanking();
  const disconnect = useDisconnectEnableBankingConnection();

  const { state, daysLeft } = getConnectionState({
    status: details?.connection.status ?? item.status,
    consentExpiration: details?.connection.consentExpiration ?? item.consentExpiration,
    paused: details?.connection.paused ?? item.paused,
  });
  const paused = state === 'paused';
  const badge = STATUS_BADGE[state];

  const isAuthoriser = details?.connection.authorizedByMe ?? (!!user?.id && item.userId === user.id);
  const isAdmin = user?.role === 'admin';
  const canDisconnect = isAdmin || isAuthoriser;
  const bankName = item.institutionName ?? details?.connection.institutionName ?? '';
  const country = item.aspspCountry ?? details?.connection.aspspCountry ?? null;
  const consentExpiration = details?.connection.consentExpiration ?? item.consentExpiration ?? null;
  const lastSync = details?.connection.lastSync ?? item.lastSync ?? null;
  const balances = (details?.accounts ?? []).filter((a) => a.lastBalance !== null && a.accountId !== null);

  const canSync = state === 'active' || state === 'expiring';
  const canReconnect = state !== 'needsMapping' && !paused;

  const handleSync = () => {
    sync.mutate(item.id, {
      onSuccess: () => {
        toast({ title: t('enableBanking.card.syncStarted'), description: t('enableBanking.card.syncStartedDesc') });
        onChanged?.();
      },
      onError: (error) => {
        const { body } = enableBankingError(error);
        if (body.code === 'SYNC_BUDGET_EXHAUSTED') {
          toast({
            title: t('enableBanking.card.budgetTitle'),
            description: body.resetsAt
              ? t('enableBanking.card.budgetDesc', { time: formatDate(body.resetsAt, language, true) })
              : t('enableBanking.card.budgetDescNoTime'),
            variant: 'destructive',
          });
          return;
        }
        const description = body.code === 'CONNECTION_NOT_ACTIVE'
          ? t('enableBanking.card.syncNotActive')
          : body.code === 'NO_MAPPED_ACCOUNTS'
            ? t('enableBanking.card.syncNoAccounts')
            : undefined;
        toast({ title: t('enableBanking.card.syncFailed'), description, variant: 'destructive' });
      },
    });
  };

  const handleReconnect = () => {
    connect.mutate(
      { reconnectItemId: item.id },
      {
        onSuccess: ({ url }) => {
          setRedirecting(true);
          window.location.assign(url);
        },
        onError: (error) => {
          const { body } = enableBankingError(error);
          toast({
            title: t('common.error'),
            description: body.code === 'NOT_AUTHORISING_USER'
              ? t('enableBanking.card.reconnectOnlyAuthoriser')
              : t('enableBanking.card.reconnectFailed'),
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleDisconnect = () => {
    disconnect.mutate(item.id, {
      onSuccess: () => {
        toast({ title: t('enableBanking.card.disconnected'), description: t('enableBanking.card.disconnectedDesc') });
        setShowDisconnect(false);
        onChanged?.();
      },
      onError: () => toast({ title: t('enableBanking.card.disconnectFailed'), variant: 'destructive' }),
    });
  };

  return (
    <Card data-testid="bank-connection-card">
      <CardContent className="pt-4 pb-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('enableBanking.card.title')}
            </span>
          </div>
          <Badge className={`text-xs ${badge.className}`} data-testid="eb-status-badge" data-state={state}>
            {t(badge.key)}
          </Badge>
        </div>

        {paused && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs" data-testid="eb-paused">
            <PauseCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
            <span className="text-muted-foreground">
              {t('enableBanking.card.pausedDesc')}{' '}
              {isAdmin ? (
                <Link to="/settings?tab=bank-sync" className="font-medium text-brand-primary hover:underline">
                  {t('enableBanking.card.pausedAdminLink')}
                </Link>
              ) : (
                t('enableBanking.card.pausedAskAdmin')
              )}
            </span>
          </div>
        )}

        {(state === 'expiring' || state === 'expired' || state === 'needsMapping' || state === 'error') && (
          <div
            className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${
              state === 'expiring' || state === 'needsMapping'
                ? 'border-warning/30 bg-warning/5'
                : 'border-destructive/30 bg-destructive/5'
            }`}
          >
            <AlertTriangle
              className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${
                state === 'expiring' || state === 'needsMapping' ? 'text-warning' : 'text-destructive'
              }`}
            />
            <span className="text-muted-foreground">
              {state === 'expiring' && t('enableBanking.card.expiringDesc')}
              {state === 'expired' && t('enableBanking.card.expiredDesc')}
              {state === 'error' && t('enableBanking.card.errorDesc')}
              {state === 'needsMapping' && t('enableBanking.card.needsMappingDesc')}
            </span>
          </div>
        )}

        <div className="divide-y">
          <Row label={t('enableBanking.card.bank')}>
            {bankName}
            {country && <span className="text-muted-foreground font-normal"> · {countryName(country, language)}</span>}
          </Row>
          {consentExpiration && (
            <Row label={t('enableBanking.card.accessExpires')}>
              {daysLeft !== null && daysLeft > 0 && state !== 'disconnected'
                ? t('enableBanking.card.expiresIn', { date: formatDate(consentExpiration, language), count: daysLeft })
                : formatDate(consentExpiration, language)}
            </Row>
          )}
          <Row label={t('enableBanking.card.lastSync')}>
            {lastSync ? formatDate(lastSync, language, true) : t('connectionHealth.never')}
          </Row>
          {balances.map((a) => (
            <Row key={a.id} label={`${a.name || t('enableBanking.mapping.unnamed')}${a.ibanLast4 ? ` •••• ${a.ibanLast4}` : ''}`}>
              <span data-testid={`eb-balance-${a.id}`}>
                {formatBalance(a.lastBalance!, a.lastBalanceCurrency ?? a.currency, language)}
              </span>
              {a.lastBalanceAt && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {t('enableBanking.card.balanceAsOf', { date: formatDate(a.lastBalanceAt, language, true) })}
                </span>
              )}
            </Row>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1">
          {state === 'needsMapping' && onOpenMapping && (
            <Button size="sm" className="col-span-2 justify-center" onClick={() => onOpenMapping(item.id)}>
              <ListChecks className="h-3.5 w-3.5 mr-2" />
              {t('enableBanking.card.mapAccounts')}
            </Button>
          )}

          {canSync && (
            <Button variant="outline" size="sm" className="justify-start" onClick={handleSync} disabled={sync.isPending}>
              <RefreshCw className={`h-3.5 w-3.5 mr-2 ${sync.isPending ? 'animate-spin' : ''}`} />
              {t('enableBanking.card.syncNow')}
            </Button>
          )}

          {canReconnect && (
            <Button
              variant={state === 'expired' || state === 'disconnected' ? 'default' : 'outline'}
              size="sm"
              className="justify-start"
              onClick={handleReconnect}
              disabled={!isAuthoriser || connect.isPending || redirecting}
            >
              <LinkIcon className="h-3.5 w-3.5 mr-2" />
              {t('enableBanking.card.reconnect')}
            </Button>
          )}

          {state !== 'needsMapping' && state !== 'disconnected' && !paused && onOpenMapping && (
            <Button variant="outline" size="sm" className="justify-start" onClick={() => onOpenMapping(item.id)}>
              <ListChecks className="h-3.5 w-3.5 mr-2" />
              {t('enableBanking.card.manageAccounts')}
            </Button>
          )}

          {state !== 'disconnected' && !paused && (
            <Button
              variant="outline"
              size="sm"
              className="justify-start text-destructive hover:text-destructive"
              onClick={() => setShowDisconnect(true)}
              disabled={!canDisconnect}
            >
              <Unlink className="h-3.5 w-3.5 mr-2" />
              {t('enableBanking.card.disconnect')}
            </Button>
          )}
        </div>

        {canReconnect && !isAuthoriser && (
          <p className="text-xs text-muted-foreground">{t('enableBanking.card.reconnectOnlyAuthoriser')}</p>
        )}
        {state !== 'disconnected' && !paused && !canDisconnect && (
          <p className="text-xs text-muted-foreground">{t('enableBanking.card.disconnectOnlyAdmin')}</p>
        )}
      </CardContent>

      <Dialog open={showDisconnect} onOpenChange={setShowDisconnect}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('enableBanking.card.disconnectTitle', { bank: bankName })}</DialogTitle>
            <DialogDescription>{t('enableBanking.card.disconnectDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDisconnect(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDisconnect} disabled={disconnect.isPending}>
              {disconnect.isPending ? t('enableBanking.card.disconnecting') : t('enableBanking.card.disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
