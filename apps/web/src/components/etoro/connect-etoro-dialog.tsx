import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAccounts } from '@/hooks/use-metadata';
import { etoroError, useConnectEtoro, useUpdateEtoroConnection } from '@/hooks/use-etoro';
import { formatCurrency } from '@/lib/utils';
import type { EtoroConnectResponse } from '@/types/api';

export const ETORO_GUIDE_URL = 'https://github.com/danielvsantos/bliss/blob/main/docs/guides/etoro-copy-trading.md';

const KNOWN_ERRORS = new Set([
  'ETORO_WRITE_SCOPE',
  'ETORO_KEY_INVALID',
  'ETORO_UNAVAILABLE',
  'ETORO_RATE_LIMITED',
  'ETORO_ALREADY_CONNECTED',
  'ETORO_DIFFERENT_LOGIN',
  'KEYS_REQUIRED',
  'ACCOUNT_REQUIRED',
]);

interface ConnectEtoroDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Replace the key of this connection instead of connecting a new account. */
  replaceConnectionId?: string;
}

/**
 * Connect an eToro account with a Read key pair (#143, R1/R2/R5), or replace
 * the key of an existing connection. The keys live in this component's state
 * only and are cleared on success; the server checks them with eToro before
 * storing anything, and refuses keys that can trade.
 */
export function ConnectEtoroDialog({ open, onOpenChange, replaceConnectionId }: ConnectEtoroDialogProps) {
  const { t } = useTranslation();
  const replacing = Boolean(replaceConnectionId);
  const { data: accounts = [] } = useAccounts();
  const connect = useConnectEtoro();
  const update = useUpdateEtoroConnection();
  const [apiKey, setApiKey] = useState('');
  const [userKey, setUserKey] = useState('');
  const [accountId, setAccountId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EtoroConnectResponse | null>(null);

  const pending = connect.isPending || update.isPending;
  const canSubmit = apiKey.trim() !== '' && userKey.trim() !== '' && (replacing || accountId !== '') && !pending;

  const close = (next: boolean) => {
    if (!next) {
      setApiKey('');
      setUserKey('');
      setError(null);
      setResult(null);
    }
    onOpenChange(next);
  };

  const onError = (err: unknown) => {
    const code = etoroError(err).body.code;
    setError(code && KNOWN_ERRORS.has(code) ? code : 'generic');
  };

  const submit = () => {
    setError(null);
    if (replacing) {
      update.mutate(
        { id: replaceConnectionId!, data: { apiKey: apiKey.trim(), userKey: userKey.trim() } },
        { onSuccess: () => close(false), onError },
      );
      return;
    }
    connect.mutate(
      { apiKey: apiKey.trim(), userKey: userKey.trim(), accountId: Number(accountId) },
      {
        onSuccess: (data) => {
          setApiKey('');
          setUserKey('');
          setResult(data);
        },
        onError,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(replacing ? 'etoro.dialog.replaceTitle' : 'etoro.dialog.title')}</DialogTitle>
          {!result && <DialogDescription>{t('etoro.dialog.description')}</DialogDescription>}
        </DialogHeader>

        {result ? (
          <div className="space-y-3" data-testid="etoro-connect-result">
            <p className="text-sm font-medium">
              {t('etoro.dialog.successTitle', { username: result.connection.etoroUsername })}
            </p>
            {result.copies.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('etoro.dialog.noCopies')}</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {t('etoro.dialog.successCopies', { count: result.copies.length })}
                </p>
                <ul className="divide-y rounded-md border">
                  {result.copies.map((c) => (
                    <li key={c.parentUsername} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="font-medium">@{c.parentUsername}</span>
                      <span className="tabular-nums text-muted-foreground">{formatCurrency(c.value, c.currency)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>{t('etoro.dialog.done')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="etoro-api-key">{t('etoro.dialog.apiKey')}</Label>
              <Input
                id="etoro-api-key"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setApiKey(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="etoro-user-key">{t('etoro.dialog.userKey')}</Label>
              <Input
                id="etoro-user-key"
                type="password"
                value={userKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setUserKey(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">{t('etoro.dialog.userKeyHint')}</p>
            </div>
            {!replacing && (
              <div className="space-y-1.5">
                <Label htmlFor="etoro-account">{t('etoro.dialog.account')}</Label>
                <Select value={accountId} onValueChange={setAccountId}>
                  <SelectTrigger id="etoro-account" aria-label={t('etoro.dialog.account')}>
                    <SelectValue placeholder={t('etoro.dialog.accountPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t('etoro.dialog.accountHint')}</p>
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive" role="alert" data-testid="etoro-connect-error">
                {t(`etoro.errors.${error}`)}
              </p>
            )}

            <a
              href={ETORO_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-brand-primary hover:underline"
            >
              {t('etoro.section.guide')}
              <ExternalLink className="h-3 w-3" />
            </a>

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => close(false)}>{t('etoro.dialog.cancel')}</Button>
              <Button type="submit" disabled={!canSubmit}>
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {pending ? t('etoro.dialog.checking') : t(replacing ? 'etoro.dialog.replaceSubmit' : 'etoro.dialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
