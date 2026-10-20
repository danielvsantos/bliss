import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, KeyRound, Loader2, Plus, RefreshCw, Repeat, Trash2 } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ConnectEtoroDialog, ETORO_GUIDE_URL } from '@/components/etoro/connect-etoro-dialog';
import {
  etoroError,
  useEtoroConnections,
  useRemoveEtoroConnection,
  useSyncEtoroConnection,
} from '@/hooks/use-etoro';
import { useToast } from '@/hooks/use-toast';
import { formatCurrency } from '@/lib/utils';
import type { EtoroConnection, EtoroConnectionStatus, EtoroCopy } from '@/types/api';

const STATUS_BADGE: Record<EtoroConnectionStatus, string> = {
  ACTIVE: 'bg-positive/10 text-positive border-positive/20',
  NEEDS_RECONNECT: 'bg-warning/10 text-warning border-warning/20',
};

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : null);

function CopyRow({ copy }: { copy: EtoroCopy }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2" data-testid={`etoro-copy-${copy.id}`}>
      <div className="min-w-0">
        <p className="text-sm font-medium">@{copy.parentUsername}</p>
        <p className="text-xs text-muted-foreground">
          {copy.startedAt && t('etoro.copy.startedAt', { date: formatDate(copy.startedAt) })}
          {copy.status === 'CLOSED' && <span className="ml-2">{t('etoro.copy.closed')}</span>}
        </p>
        {copy.linkedHolding ? (
          <p className="text-xs text-positive">{t('etoro.copy.linkedTo', { symbol: copy.linkedHolding.symbol })}</p>
        ) : (
          <p className="text-xs text-warning" title={t('etoro.copy.notLinkedHint', { username: copy.parentUsername })}>
            {t('etoro.copy.notLinked')}
          </p>
        )}
      </div>
      {copy.lastValue != null && (
        <span className="text-sm tabular-nums">{formatCurrency(copy.lastValue, copy.lastValueCurrency)}</span>
      )}
    </li>
  );
}

function ConnectionCard({ connection, onReplaceKey }: { connection: EtoroConnection; onReplaceKey: (id: string) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const sync = useSyncEtoroConnection();
  const remove = useRemoveEtoroConnection();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const unlinked = connection.copies.filter((c) => !c.linkedHolding);

  const syncNow = () => {
    sync.mutate(connection.id, {
      onSuccess: () => toast({ title: t('etoro.connection.syncStarted') }),
      onError: (err) => {
        const { body } = etoroError(err);
        toast({
          title: body.code === 'COOLDOWN'
            ? t('etoro.connection.cooldown', { minutes: Math.max(1, Math.ceil((body.retryAfter ?? 60) / 60)) })
            : t('etoro.errors.generic'),
          variant: body.code === 'COOLDOWN' ? 'default' : 'destructive',
        });
      },
    });
  };

  return (
    <Card className="p-4 space-y-3" data-testid={`etoro-connection-${connection.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium">{connection.etoroUsername}</p>
            <Badge className={STATUS_BADGE[connection.status]} data-testid="etoro-connection-status">
              {t(`etoro.status.${connection.status}`)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {t('etoro.connection.account')}: {connection.account?.name ?? t('etoro.connection.noAccount')}
            {' · '}
            {t('etoro.connection.key')}: ••••{connection.keyLast4}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('etoro.connection.lastSync')}: {formatDate(connection.lastSyncAt) ?? t('etoro.connection.never')}
          </p>
          {connection.lastSyncStatus === 'FAILED' && (
            <p className="text-xs text-warning">
              {t('etoro.connection.lastSyncFailed', { code: connection.lastSyncError ?? '—' })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {connection.status === 'ACTIVE' && (
            <Button type="button" variant="outline" size="sm" onClick={syncNow} disabled={sync.isPending}>
              {sync.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              {t('etoro.connection.syncNow')}
            </Button>
          )}
          <Button
            type="button"
            variant={connection.status === 'NEEDS_RECONNECT' ? 'default' : 'outline'}
            size="sm"
            onClick={() => onReplaceKey(connection.id)}
          >
            <KeyRound className="mr-1.5 h-3.5 w-3.5" />
            {t('etoro.connection.replaceKey')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(true)} aria-label={t('etoro.connection.remove')}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('etoro.connection.copies')}</p>
        {connection.copies.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">{t('etoro.connection.noCopies')}</p>
        ) : (
          <ul className="divide-y">{connection.copies.map((c) => <CopyRow key={c.id} copy={c} />)}</ul>
        )}
        {unlinked.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            {t('etoro.copy.notLinkedHint', { username: unlinked.map((c) => c.parentUsername).join(', ') })}
          </p>
        )}
      </div>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('etoro.connection.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('etoro.connection.removeDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('etoro.dialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate(connection.id, {
                onSuccess: () => toast({ title: t('etoro.connection.removed') }),
                onError: () => toast({ title: t('etoro.errors.generic'), variant: 'destructive' }),
              })}
            >
              {t('etoro.connection.removeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/**
 * Settings → Bank sync → eToro copy trading (#143). Admins connect an eToro
 * account with a Read key; each connection lists its copies and whether each
 * one is linked to a Copy Trading holding.
 */
export function EtoroSection() {
  const { t } = useTranslation();
  const { data: connections, isLoading, isError } = useEtoroConnections();
  const [connectOpen, setConnectOpen] = useState(false);
  const [replaceId, setReplaceId] = useState<string | null>(null);

  return (
    <section className="space-y-3" data-testid="etoro-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Repeat className="h-4 w-4 text-brand-primary" />
            {t('etoro.section.title')}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">{t('etoro.section.description')}</p>
          <a
            href={ETORO_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-brand-primary hover:underline mt-1"
          >
            {t('etoro.section.guide')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <Button type="button" onClick={() => setConnectOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t('etoro.section.connect')}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">{t('etoro.section.loadFailed')}</p>
      ) : !connections?.length ? (
        <Card className="p-4 text-sm text-muted-foreground" data-testid="etoro-empty">{t('etoro.section.empty')}</Card>
      ) : (
        <div className="space-y-3">
          {connections.map((c) => <ConnectionCard key={c.id} connection={c} onReplaceKey={setReplaceId} />)}
        </div>
      )}

      {connectOpen && <ConnectEtoroDialog open={connectOpen} onOpenChange={setConnectOpen} />}
      {replaceId && (
        <ConnectEtoroDialog
          open
          replaceConnectionId={replaceId}
          onOpenChange={(open) => { if (!open) setReplaceId(null); }}
        />
      )}
    </section>
  );
}
