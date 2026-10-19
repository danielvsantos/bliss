import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, ExternalLink, Globe, Loader2, RefreshCw, Trash2 } from 'lucide-react';

import {
  useEnableBankingCredentials,
  useRemoveEnableBankingCredentials,
  useSaveEnableBankingCredentials,
  useVerifyEnableBankingCredentials,
} from '@/hooks/use-enable-banking-credentials';
import { enableBankingError } from '@/hooks/use-enable-banking';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/enable-banking';
import type { PemErrorCode } from '@/lib/pem';
import { checkPrivateKey } from '@/lib/pem';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { EnableBankingKeyInput } from '@/components/settings/enable-banking-key-input';

import type { EnableBankingCredentialStatus, EnableBankingCredentialsView } from '@/types/api';

const T = 'enableBanking.credentials';
export const ENABLE_BANKING_GUIDE_URL = 'https://github.com/danielvsantos/bliss/blob/main/docs/guides/enable-banking.md';
const APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_ERRORS = ['INVALID_CREDENTIALS', 'SANDBOX_APP', 'INVALID_APP_ID'] as const;

const STATUS_BADGE: Record<EnableBankingCredentialStatus, string> = {
  VERIFIED: 'bg-positive/10 text-positive border-positive/20',
  UNVERIFIED: 'bg-warning/10 text-warning border-warning/20',
  INVALID: 'bg-destructive/10 text-destructive border-destructive/20',
};

function StatusBadge({ status }: { status: EnableBankingCredentialStatus }) {
  const { t } = useTranslation();
  return <Badge className={STATUS_BADGE[status]} data-testid="eb-credential-status">{t(`${T}.status${status}`)}</Badge>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right break-all">{children}</span>
    </div>
  );
}

function CallbackUrl({ url }: { url: string }) {
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
function CredentialsForm({
  view,
  initialAppId,
  onCancel,
  onSaved,
}: {
  view: EnableBankingCredentialsView;
  initialAppId: string;
  onCancel?: () => void;
  onSaved: () => void;
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
          onSaved();
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

function ConfiguredView({ view, onReplace }: { view: EnableBankingCredentialsView; onReplace: () => void }) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const verify = useVerifyEnableBankingCredentials();
  const remove = useRemoveEnableBankingCredentials();
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const credential = view.credential!;

  const handleVerify = () => {
    verify.mutate(undefined, {
      onSuccess: (result) => {
        const status = result.credential?.status;
        toast({
          title: status === 'VERIFIED'
            ? t(`${T}.verifiedTitle`)
            : status === 'INVALID' ? t(`${T}.stillInvalidTitle`) : t(`${T}.stillUnverifiedTitle`),
          ...(status !== 'VERIFIED' && { variant: 'destructive' as const }),
        });
      },
      onError: () => toast({ title: t(`${T}.errorGeneric`), variant: 'destructive' }),
    });
  };

  const handleRemove = (confirm: boolean) => {
    remove.mutate(confirm, {
      onSuccess: () => {
        setConfirmRemove(null);
        toast({ title: t(`${T}.removedTitle`), description: t(`${T}.removedDesc`) });
      },
      onError: (err) => {
        const { body } = enableBankingError(err);
        if (body.code === 'CONFIRMATION_REQUIRED') {
          setConfirmRemove(Number(body.affectedConnections) || 0);
          return;
        }
        toast({ title: t(`${T}.errorGeneric`), variant: 'destructive' });
      },
    });
  };

  return (
    <div className="space-y-4">
      {credential.status !== 'VERIFIED' && (
        <div
          className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${
            credential.status === 'INVALID' ? 'border-destructive/30 bg-destructive/5' : 'border-warning/30 bg-warning/5'
          }`}
        >
          <AlertTriangle className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${credential.status === 'INVALID' ? 'text-destructive' : 'text-warning'}`} />
          <span className="text-muted-foreground">
            {credential.status === 'INVALID' ? t(`${T}.invalidDesc`) : t(`${T}.unverifiedDesc`)}
          </span>
        </div>
      )}
      {credential.callbackRegistered === false && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs" data-testid="eb-callback-missing">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
          <span className="text-muted-foreground">{t(`${T}.callbackMissing`)}</span>
        </div>
      )}

      <div className="divide-y">
        <Row label={t(`${T}.appId`)}><span className="font-mono text-xs">{credential.appId}</span></Row>
        <Row label={t(`${T}.fingerprint`)}>
          <span className="font-mono text-xs" data-testid="eb-key-fingerprint">{credential.keyFingerprint}</span>
          <span className="block text-xs font-normal text-muted-foreground">{t(`${T}.keyBits`, { bits: credential.keyBits })}</span>
        </Row>
        <Row label={t(`${T}.lastValidated`)}>
          {credential.lastValidatedAt ? formatDate(credential.lastValidatedAt, i18n?.language, true) : t(`${T}.never`)}
        </Row>
        <Row label={t(`${T}.activeConnections`)}>{view.usage.activeConnections}</Row>
        <Row label={t(`${T}.linkedAccounts`)}>
          {t(`${T}.linkedAccountsValue`, { used: view.usage.linkedAccounts, limit: view.usage.limit })}
        </Row>
      </div>

      <CallbackUrl url={view.callbackUrl} />

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={handleVerify} disabled={verify.isPending}>
          <RefreshCw className={`h-3.5 w-3.5 mr-2 ${verify.isPending ? 'animate-spin' : ''}`} />
          {t(`${T}.reverify`)}
        </Button>
        <Button variant="outline" size="sm" onClick={onReplace}>
          {t(`${T}.replace`)}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => handleRemove(false)}
          disabled={remove.isPending}
        >
          <Trash2 className="h-3.5 w-3.5 mr-2" />
          {t(`${T}.remove`)}
        </Button>
      </div>

      <AlertDialog open={confirmRemove !== null} onOpenChange={(open) => !open && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`${T}.confirmRemoveTitle`)}</AlertDialogTitle>
            <AlertDialogDescription>{t(`${T}.confirmRemoveDesc`, { count: confirmRemove ?? 0 })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(`${T}.cancel`)}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => handleRemove(true)}
            >
              {t(`${T}.remove`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function History({ view }: { view: EnableBankingCredentialsView }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t(`${T}.historyTitle`)}</h3>
      {view.history.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t(`${T}.historyEmpty`)}</p>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="eb-credential-history">
          {view.history.map((h, i) => (
            <li key={`${h.createdAt}-${i}`} className="flex flex-col gap-0.5 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
              <span>
                <span className="font-medium">{t(`${T}.history${h.action}`)}</span>
                <span className="text-muted-foreground"> · <span className="font-mono">{h.appId}</span></span>
                {h.keyFingerprint && <span className="text-muted-foreground"> · <span className="font-mono">{h.keyFingerprint}</span></span>}
              </span>
              <span className="text-muted-foreground">
                {t(`${T}.historyBy`, { name: h.user?.name || t(`${T}.historyUnknownUser`) })} · {formatDate(h.createdAt, i18n?.language, true)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Settings → Bank sync (#148, admins only): the tenant's own Enable Banking
 * application. Status colours use design tokens only.
 */
export function BankSyncTab() {
  const { t } = useTranslation();
  const { data: view, isLoading, isError } = useEnableBankingCredentials();
  const [replacing, setReplacing] = useState(false);

  if (isLoading) {
    return (
      <Card className="p-6 space-y-3">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }
  if (isError || !view) {
    return <Card className="p-6 text-sm text-destructive">{t(`${T}.loadFailed`)}</Card>;
  }

  const showForm = !view.configured || replacing;

  return (
    <Card className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">{t(`${T}.title`)}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t(`${T}.intro`)}</p>
          <a
            href={ENABLE_BANKING_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline"
          >
            {t(`${T}.guideLink`)}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        {view.credential && <StatusBadge status={view.credential.status} />}
      </div>

      {!view.configured && view.usage.pausedConnections > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm" data-testid="eb-paused-banner">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
          <span>{t(`${T}.pausedBanner`, { count: view.usage.pausedConnections })}</span>
        </div>
      )}

      {showForm ? (
        <CredentialsForm
          key={replacing ? 'replace' : 'set'}
          view={view}
          initialAppId={replacing ? view.credential?.appId ?? '' : ''}
          onCancel={replacing ? () => setReplacing(false) : undefined}
          onSaved={() => setReplacing(false)}
        />
      ) : (
        <ConfiguredView view={view} onReplace={() => setReplacing(true)} />
      )}

      <History view={view} />
    </Card>
  );
}
