import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react';

import { useSaveEnableBankingCredentials } from '@/hooks/use-enable-banking-credentials';
import { enableBankingError } from '@/hooks/use-enable-banking';
import { useToast } from '@/hooks/use-toast';
import type { PemErrorCode } from '@/lib/pem';
import { checkPrivateKey } from '@/lib/pem';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { EnableBankingKeyInput } from '@/components/settings/enable-banking-key-input';

import type { EnableBankingCredentialsView } from '@/types/api';

/**
 * The Enable Banking credentials form (#148), shared by Settings → Bank sync
 * and the onboarding EU setup dialog (#154) so key handling exists once.
 */

const T = 'enableBanking.credentials';
const APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_ERRORS = ['INVALID_CREDENTIALS', 'SANDBOX_APP', 'INVALID_APP_ID'] as const;

export function CallbackUrl({ url }: { url: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable: the URL stays selectable.
    }
  };
  return (
    <div className="space-y-1.5">
      <Label>{t(`${T}.callbackLabel`)}</Label>
      <div className="flex gap-2">
        <Input readOnly value={url} className="font-mono text-xs" data-testid="eb-callback-url" onFocus={(e) => e.target.select()} />
        <Button type="button" variant="outline" size="sm" onClick={copy} className="shrink-0">
          {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
          {copied ? t(`${T}.copied`) : t(`${T}.copy`)}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t(`${T}.callbackHint`)}</p>
    </div>
  );
}

/** Set or replace the credentials. The key lives in this component's state only. */
export function CredentialsForm({
  view,
  initialAppId,
  onCancel,
  onSaved,
}: {
  view: EnableBankingCredentialsView;
  initialAppId: string;
  onCancel?: () => void;
  /** Receives the saved view: onboarding (#154) hands off to connect when VERIFIED. */
  onSaved: (view: EnableBankingCredentialsView) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const save = useSaveEnableBankingCredentials();
  const [appId, setAppId] = useState(initialAppId);
  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<PemErrorCode | null>(null);
  const [confirmCount, setConfirmCount] = useState<number | null>(null);

  const appIdValid = APP_ID_PATTERN.test(appId.trim());
  const keyCheck = privateKey ? checkPrivateKey(privateKey) : null;
  const canSave = appIdValid && keyCheck?.ok === true && !save.isPending;

  const submit = (confirmAppChange = false) => {
    setError(null);
    setKeyError(null);
    save.mutate(
      { appId: appId.trim(), privateKey, ...(confirmAppChange && { confirmAppChange: true }) },
      {
        onSuccess: (result) => {
          // The key leaves the page: state cleared, mutation variables dropped.
          setPrivateKey('');
          setConfirmCount(null);
          save.reset();
          const unverified = result.credential?.status === 'UNVERIFIED';
          toast({
            title: t(`${T}.savedTitle`),
            description: unverified ? t(`${T}.savedUnverifiedDesc`) : t(`${T}.savedDesc`),
          });
          onSaved(result);
        },
        onError: (err) => {
          const { body } = enableBankingError(err);
          if (body.code === 'CONFIRMATION_REQUIRED') {
            setConfirmCount(Number(body.affectedConnections) || 0);
            return;
          }
          setConfirmCount(null);
          if (body.code?.startsWith('KEY_')) {
            setKeyError(body.code as PemErrorCode);
            return;
          }
          setError((SERVER_ERRORS as readonly string[]).includes(body.code ?? '') ? t(`${T}.error${body.code}`) : t(`${T}.errorGeneric`));
        },
      },
    );
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) submit();
      }}
    >
      <CallbackUrl url={view.callbackUrl} />

      <div className="space-y-1.5">
        <Label htmlFor="eb-app-id">{t(`${T}.appIdLabel`)}</Label>
        <Input
          id="eb-app-id"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          placeholder="6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          disabled={save.isPending}
        />
        {appId.trim() !== '' && !appIdValid && <p className="text-xs text-destructive">{t(`${T}.appIdInvalid`)}</p>}
      </div>

      <EnableBankingKeyInput
        value={privateKey}
        onChange={(v) => {
          setKeyError(null);
          setPrivateKey(v);
        }}
        disabled={save.isPending}
        serverError={keyError}
      />
      {view.configured && <p className="text-xs text-muted-foreground">{t(`${T}.replaceHint`)}</p>}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs" role="alert">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={save.isPending}>
            {t(`${T}.cancel`)}
          </Button>
        )}
        <Button type="submit" disabled={!canSave}>
          {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {save.isPending ? t(`${T}.saving`) : t(`${T}.save`)}
        </Button>
      </div>

      <AlertDialog open={confirmCount !== null} onOpenChange={(open) => !open && setConfirmCount(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`${T}.confirmAppChangeTitle`)}</AlertDialogTitle>
            <AlertDialogDescription>{t(`${T}.confirmAppChangeDesc`, { count: confirmCount ?? 0 })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(`${T}.cancel`)}</AlertDialogCancel>
            <AlertDialogAction onClick={() => submit(true)}>{t(`${T}.confirmContinue`)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
