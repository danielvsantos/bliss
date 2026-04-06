import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  RefreshCw,
  RotateCw,
  Link as LinkIcon,
  Unlink,
  Edit2,
  Landmark,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  useResyncPlaidItem,
  useRotatePlaidToken,
  useDisconnectPlaidItem,
} from '@/hooks/use-plaid-actions';
import { PlaidConnect } from '@/components/plaid-connect';
import { ConnectionHealth } from './connection-health';
import { SyncLogsTable } from './sync-logs-table';
import type { EnrichedAccount } from '@/hooks/use-account-list';

interface AccountDetailPanelProps {
  account: EnrichedAccount;
  onEdit: () => void;
  onRefetch: () => void;
}

export function AccountDetailPanel({ account, onEdit, onRefetch }: AccountDetailPanelProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);

  const resync = useResyncPlaidItem();
  const rotateToken = useRotatePlaidToken();
  const disconnect = useDisconnectPlaidItem();

  const isPlaid = account.plaidItem !== null;
  const isDisconnected = account.status === 'disconnected';
  const plaidItemId = account.plaidItem?.id ?? null;

  const handleResync = () => {
    if (!plaidItemId) return;
    resync.mutate(plaidItemId, {
      onSuccess: () => {
        toast({ title: t('accountDetail.syncTriggered'), description: t('accountDetail.syncTriggeredDesc') });
        onRefetch();
      },
      onError: () => toast({ title: t('accountDetail.syncFailed'), variant: 'destructive' }),
    });
  };

  const handleRotateToken = () => {
    if (!plaidItemId) return;
    rotateToken.mutate(plaidItemId, {
      onSuccess: () => {
        toast({ title: t('accountDetail.tokenRotated'), description: t('accountDetail.tokenRotatedDesc') });
        onRefetch();
      },
      onError: () => toast({ title: t('accountDetail.tokenRotateFailed'), variant: 'destructive' }),
    });
  };

  const handleDisconnect = () => {
    if (!plaidItemId) return;
    disconnect.mutate(plaidItemId, {
      onSuccess: () => {
        toast({ title: t('accountDetail.disconnected'), description: t('accountDetail.disconnectedDesc') });
        setShowDisconnectDialog(false);
        onRefetch();
      },
      onError: () => toast({ title: t('accountDetail.disconnectFailed'), variant: 'destructive' }),
    });
  };

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{account.accountName}</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm text-muted-foreground">{account.institution}</span>
            <span className="text-sm text-muted-foreground font-mono">{account.mask}</span>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="outline" className="text-xs">{account.currencyCode}</Badge>
            {isPlaid && (
              <Badge variant="default" className="text-xs bg-brand-primary/10 text-brand-primary border-brand-primary/20 hover:bg-brand-primary/10">
                <Landmark className="h-3 w-3 mr-1" /> {t('accountDetail.plaidConnected')}
              </Badge>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Edit2 className="h-3.5 w-3.5 mr-1" /> {t('common.edit')}
        </Button>
      </div>

      <Separator />

      {/* Connection Health */}
      <ConnectionHealth account={account} onRefetch={onRefetch} />

      {/* Consent Expiration Alert */}
      {isPlaid && account.plaidItem?.consentExpiration && (() => {
        const expiry = new Date(account.plaidItem!.consentExpiration!);
        const now = new Date();
        const daysUntilExpiry = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const isExpired = daysUntilExpiry <= 0;
        const isExpiringSoon = daysUntilExpiry > 0 && daysUntilExpiry <= 30;

        if (!isExpired && !isExpiringSoon) return null;

        return (
          <Card className={isExpired
            ? 'border-destructive/30 bg-destructive/5'
            : 'border-warning/30 bg-warning/5'
          }>
            <CardContent className="pt-4 pb-3 flex items-start gap-3">
              <AlertTriangle className={`h-4 w-4 mt-0.5 shrink-0 ${isExpired ? 'text-destructive' : 'text-warning'}`} />
              <div className="space-y-1">
                <p className={`text-sm font-medium ${isExpired ? 'text-destructive' : 'text-warning'}`}>
                  {isExpired ? t('accountDetail.consentExpired') : t('accountDetail.consentExpiringSoon')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {isExpired
                    ? t('accountDetail.consentExpiredDesc', { date: expiry.toLocaleDateString() })
                    : t('accountDetail.consentExpiringSoonDesc', { date: expiry.toLocaleDateString(), days: daysUntilExpiry })}
                </p>
                <PlaidConnect
                  plaidItemId={plaidItemId!}
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onSuccess={() => onRefetch()}
                >
                  <LinkIcon className="h-3.5 w-3.5 mr-2" />
                  {t('accountDetail.reconnect')}
                </PlaidConnect>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* Reconnect — shown only when account is disconnected (REVOKED) */}
      {isPlaid && isDisconnected && (
        <Card>
          <CardContent className="pt-4 pb-3 space-y-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">
              {t('accountDetail.reconnect')}
            </span>
            <p className="text-sm text-muted-foreground">
              {t('accountDetail.reconnectDesc')}
            </p>
            <PlaidConnect
              plaidItemId={plaidItemId!}
              variant="default"
              className="w-full justify-center"
              onSuccess={() => onRefetch()}
            >
              <LinkIcon className="h-3.5 w-3.5 mr-2" />
              {t('accountDetail.reconnectBank')}
            </PlaidConnect>
          </CardContent>
        </Card>
      )}

      {/* Actions — only for active Plaid accounts (hidden when disconnected) */}
      {isPlaid && !isDisconnected && (
        <Card>
          <CardContent className="pt-4 pb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 block">
              {t('accountDetail.actions')}
            </span>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleResync}
                disabled={resync.isPending}
                className="justify-start"
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-2 ${resync.isPending ? 'animate-spin' : ''}`} />
                {t('accountDetail.resyncNow')}
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleRotateToken}
                disabled={rotateToken.isPending}
                className="justify-start"
              >
                <RotateCw className={`h-3.5 w-3.5 mr-2 ${rotateToken.isPending ? 'animate-spin' : ''}`} />
                {t('accountDetail.rotateToken')}
              </Button>

              <PlaidConnect
                plaidItemId={plaidItemId!}
                variant="outline"
                className="justify-start text-sm h-9"
                onSuccess={() => onRefetch()}
              >
                <LinkIcon className="h-3.5 w-3.5 mr-2" />
                {t('accountDetail.relinkPlaid')}
              </PlaidConnect>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDisconnectDialog(true)}
                className="justify-start text-destructive hover:text-destructive"
              >
                <Unlink className="h-3.5 w-3.5 mr-2" />
                {t('accountDetail.pauseSync')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Security info */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-positive" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('accountDetail.security')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {t('accountDetail.securityDesc')}
            {isPlaid && ` ${t('accountDetail.securityPlaid')}`}
          </p>
        </CardContent>
      </Card>

      {/* Sync Logs — hidden when disconnected */}
      {isPlaid && !isDisconnected && <SyncLogsTable plaidItemId={plaidItemId} />}

      {/* Disconnect Confirmation Dialog */}
      <Dialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('accountDetail.pauseSyncTitle')}</DialogTitle>
            <DialogDescription>
              {t('accountDetail.pauseSyncDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDisconnectDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? t('accountDetail.disconnecting') : t('accountDetail.disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
