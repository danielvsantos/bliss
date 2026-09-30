import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
} from 'lucide-react';

import {
  useAddApiKey,
  useCreateIntegration,
  useIntegrations,
  useRenameIntegration,
  useRevokeApiKey,
  useRevokeIntegration,
} from '@/hooks/use-integrations';
import { useToast } from '@/hooks/use-toast';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { cn } from '@/lib/utils';

import type {
  ApiKeySummary,
  Integration,
  IntegrationAccessLevel,
  KeyExpiryDays,
} from '@/types/integrations';

const T = 'pages.settings.integrations';

const EXPIRY_OPTIONS: { value: string; days: KeyExpiryDays; labelKey: string }[] = [
  { value: '30', days: 30, labelKey: 'form.expiry_30' },
  { value: '90', days: 90, labelKey: 'form.expiry_90' },
  { value: '365', days: 365, labelKey: 'form.expiry_365' },
  { value: 'never', days: null, labelKey: 'form.expiry_never' },
];

function apiBaseUrl(): string {
  const configured = (import.meta.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '').replace(/\/api$/, '');
  return configured || window.location.origin;
}

function formatDate(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

// ─── Badges ─────────────────────────────────────────────────────────────────

function AccessBadge({ level }: { level: IntegrationAccessLevel }) {
  const { t } = useTranslation();
  return level === 'READ_WRITE' ? (
    <Badge className="bg-warning/10 text-warning border-warning/20">{t(`${T}.access_read_write`)}</Badge>
  ) : (
    <Badge className="bg-muted text-muted-foreground border-border">{t(`${T}.access_read_only`)}</Badge>
  );
}

function StatusBadge({ status }: { status: 'active' | 'revoked' | 'expired' }) {
  const { t } = useTranslation();
  const styles = {
    active: 'bg-positive/10 text-positive border-positive/20',
    revoked: 'bg-destructive/10 text-destructive border-destructive/20',
    expired: 'bg-muted text-muted-foreground border-border',
  } as const;
  return <Badge className={styles[status]}>{t(`${T}.status_${status}`)}</Badge>;
}

// ─── Form pieces ────────────────────────────────────────────────────────────

function AccessLevelField({
  value,
  onChange,
}: {
  value: IntegrationAccessLevel;
  onChange: (value: IntegrationAccessLevel) => void;
}) {
  const { t } = useTranslation();
  const options: { value: IntegrationAccessLevel; label: string; description: string }[] = [
    { value: 'READ_ONLY', label: t(`${T}.access_read_only`), description: t(`${T}.access_read_only_description`) },
    { value: 'READ_WRITE', label: t(`${T}.access_read_write`), description: t(`${T}.access_read_write_description`) },
  ];
  return (
    <div className="space-y-2">
      <Label>{t(`${T}.form.access_label`)}</Label>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as IntegrationAccessLevel)}
        className="gap-2"
      >
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`access-${option.value}`}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors',
              value === option.value && 'border-brand-primary bg-brand-primary/5',
            )}
          >
            <RadioGroupItem id={`access-${option.value}`} value={option.value} className="mt-0.5" />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium text-foreground">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">{t(`${T}.form.access_fixed`)}</p>
    </div>
  );
}

function ExpiryField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label>{t(`${T}.form.expiry_label`)}</Label>
      <RadioGroup value={value} onValueChange={onChange} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {EXPIRY_OPTIONS.map((option) => (
          <label
            key={option.value}
            htmlFor={`expiry-${option.value}`}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm',
              value === option.value && 'border-brand-primary bg-brand-primary/5',
            )}
          >
            <RadioGroupItem id={`expiry-${option.value}`} value={option.value} />
            {t(`${T}.${option.labelKey}`)}
          </label>
        ))}
      </RadioGroup>
      {value === 'never' && (
        <p className="flex items-start gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {t(`${T}.form.no_expiry_warning`)}
        </p>
      )}
    </div>
  );
}

function expiryDays(value: string): KeyExpiryDays {
  const option = EXPIRY_OPTIONS.find((o) => o.value === value);
  // `days` is null for "no expiry" — don't let `??` turn that into a default.
  return option ? option.days : 90;
}

// ─── One-time token reveal ──────────────────────────────────────────────────

/** Copy-to-clipboard with a short "copied" state. */
function useCopy() {
  const [copied, setCopied] = useState(false);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return { copied, copy };
}

export function TokenReveal({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useTranslation();
  const tokenCopy = useCopy();
  const mcpCopy = useCopy();
  const curl = `curl -H "Authorization: Bearer ${token}" \\\n  ${apiBaseUrl()}/api/transactions`;
  // MCP server for AI agents (#89): the same key works with Claude Code.
  const mcpUrl = `${apiBaseUrl()}/api/mcp`;
  const mcpHeader = `--header "Authorization: Bearer ${token}"`;
  const mcpCommand = `claude mcp add --transport http bliss ${mcpUrl} ${mcpHeader}`;

  return (
    <div className="space-y-4" data-testid="token-reveal">
      <p className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        {t(`${T}.reveal.warning`)}
      </p>
      <div className="flex gap-2">
        <Input
          readOnly
          value={token}
          aria-label={t(`${T}.reveal.title`)}
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" onClick={() => tokenCopy.copy(token)} className="shrink-0">
          {tokenCopy.copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
          {tokenCopy.copied ? t(`${T}.reveal.copied`) : t(`${T}.reveal.copy`)}
        </Button>
      </div>
      <div className="space-y-1.5">
        <Label>{t(`${T}.reveal.example`)}</Label>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground">
          {curl}
        </pre>
      </div>
      <div className="space-y-1.5" data-testid="mcp-snippet">
        <div className="flex items-center justify-between gap-2">
          <Label>{t(`${T}.mcp.title`)}</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => mcpCopy.copy(mcpCommand)}
            aria-label={t(`${T}.mcp.copy_command`)}
          >
            {mcpCopy.copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
            {mcpCopy.copied ? t(`${T}.reveal.copied`) : t(`${T}.mcp.copy_command`)}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t(`${T}.mcp.description`)}</p>
        <p className="text-xs text-muted-foreground">
          {t(`${T}.mcp.url_label`)} <code className="font-mono text-foreground">{mcpUrl}</code>
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground">
          {`claude mcp add --transport http bliss ${mcpUrl} \\\n  ${mcpHeader}`}
        </pre>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>{t(`${T}.reveal.done`)}</Button>
      </DialogFooter>
    </div>
  );
}

// ─── Dialogs ────────────────────────────────────────────────────────────────

function CreateIntegrationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const create = useCreateIntegration();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [accessLevel, setAccessLevel] = useState<IntegrationAccessLevel>('READ_ONLY');
  const [keyName, setKeyName] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [nameError, setNameError] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  function reset() {
    setName('');
    setDescription('');
    setAccessLevel('READ_ONLY');
    setKeyName('');
    setExpiry('90');
    setNameError(false);
    setToken(null);
  }

  function handleOpenChange(value: boolean) {
    // Closing always drops the plaintext token from state.
    if (!value) reset();
    onOpenChange(value);
  }

  async function submit() {
    if (!name.trim()) {
      setNameError(true);
      return;
    }
    try {
      const result = await create.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        accessLevel,
        key: { name: keyName.trim() || undefined, expiresInDays: expiryDays(expiry) },
      });
      setToken(result.token);
      toast({ title: t(`${T}.toast.created`) });
    } catch {
      toast({ title: t(`${T}.toast.error`), variant: 'destructive' });
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{token ? t(`${T}.reveal.title`) : t(`${T}.create_title`)}</DialogTitle>
          <DialogDescription>{token ? t(`${T}.reveal.subtitle`) : t(`${T}.description`)}</DialogDescription>
        </DialogHeader>

        {token ? (
          <TokenReveal token={token} onDone={() => handleOpenChange(false)} />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="integration-name">{t(`${T}.form.name_label`)}</Label>
              <Input
                id="integration-name"
                value={name}
                maxLength={80}
                placeholder={t(`${T}.form.name_placeholder`)}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(false);
                }}
              />
              {nameError && <p className="text-xs text-destructive">{t(`${T}.form.name_required`)}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="integration-description">{t(`${T}.form.description_label`)}</Label>
              <Input
                id="integration-description"
                value={description}
                maxLength={280}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <AccessLevelField value={accessLevel} onChange={setAccessLevel} />
            <div className="space-y-1.5">
              <Label htmlFor="integration-key-name">{t(`${T}.form.key_name_label`)}</Label>
              <Input
                id="integration-key-name"
                value={keyName}
                maxLength={80}
                placeholder={t(`${T}.form.key_name_placeholder`)}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </div>
            <ExpiryField value={expiry} onChange={setExpiry} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                {t(`${T}.form.cancel`)}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t(`${T}.form.create_submit`)}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddKeyDialog({
  integration,
  onOpenChange,
}: {
  integration: Integration | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const addKey = useAddApiKey();
  const [keyName, setKeyName] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [token, setToken] = useState<string | null>(null);

  function handleOpenChange(value: boolean) {
    if (!value) {
      setKeyName('');
      setExpiry('90');
      setToken(null);
    }
    onOpenChange(value);
  }

  async function submit() {
    if (!integration) return;
    try {
      const result = await addKey.mutateAsync({
        integrationId: integration.id,
        name: keyName.trim() || undefined,
        expiresInDays: expiryDays(expiry),
      });
      setToken(result.token);
      toast({ title: t(`${T}.toast.key_created`) });
    } catch {
      toast({ title: t(`${T}.toast.error`), variant: 'destructive' });
    }
  }

  return (
    <Dialog open={integration !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{token ? t(`${T}.reveal.title`) : t(`${T}.add_key_title`)}</DialogTitle>
          <DialogDescription>{token ? t(`${T}.reveal.subtitle`) : integration?.name}</DialogDescription>
        </DialogHeader>
        {token ? (
          <TokenReveal token={token} onDone={() => handleOpenChange(false)} />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="key-name">{t(`${T}.form.key_name_label`)}</Label>
              <Input
                id="key-name"
                value={keyName}
                maxLength={80}
                placeholder={t(`${T}.form.key_name_placeholder`)}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </div>
            <ExpiryField value={expiry} onChange={setExpiry} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                {t(`${T}.form.cancel`)}
              </Button>
              <Button type="submit" disabled={addKey.isPending}>
                {addKey.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t(`${T}.form.add_key_submit`)}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  integration,
  onOpenChange,
}: {
  integration: Integration | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const rename = useRenameIntegration();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (integration && loadedFor !== integration.id) {
    setLoadedFor(integration.id);
    setName(integration.name);
    setDescription(integration.description ?? '');
  }

  function handleOpenChange(value: boolean) {
    if (!value) setLoadedFor(null);
    onOpenChange(value);
  }

  async function submit() {
    if (!integration || !name.trim()) return;
    try {
      await rename.mutateAsync({ id: integration.id, name: name.trim(), description: description.trim() || null });
      toast({ title: t(`${T}.toast.renamed`) });
      handleOpenChange(false);
    } catch {
      toast({ title: t(`${T}.toast.error`), variant: 'destructive' });
    }
  }

  return (
    <Dialog open={integration !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(`${T}.rename_title`)}</DialogTitle>
          <DialogDescription>{t(`${T}.form.access_fixed`)}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="rename-name">{t(`${T}.form.name_label`)}</Label>
            <Input id="rename-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rename-description">{t(`${T}.form.description_label`)}</Label>
            <Input
              id="rename-description"
              value={description}
              maxLength={280}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              {t(`${T}.form.cancel`)}
            </Button>
            <Button type="submit" disabled={rename.isPending || !name.trim()}>
              {rename.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t(`${T}.form.save`)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type PendingRevoke =
  | { kind: 'integration'; integration: Integration }
  | { kind: 'key'; integration: Integration; key: ApiKeySummary };

function RevokeConfirmDialog({
  pending,
  onOpenChange,
}: {
  pending: PendingRevoke | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const revokeIntegration = useRevokeIntegration();
  const revokeKey = useRevokeApiKey();
  const isPending = revokeIntegration.isPending || revokeKey.isPending;

  async function confirm() {
    if (!pending) return;
    try {
      if (pending.kind === 'integration') {
        await revokeIntegration.mutateAsync(pending.integration.id);
        toast({ title: t(`${T}.toast.revoked`) });
      } else {
        await revokeKey.mutateAsync({ integrationId: pending.integration.id, keyId: pending.key.id });
        toast({ title: t(`${T}.toast.key_revoked`) });
      }
      onOpenChange(false);
    } catch {
      toast({ title: t(`${T}.toast.error`), variant: 'destructive' });
    }
  }

  const isKey = pending?.kind === 'key';
  return (
    <AlertDialog open={pending !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isKey ? t(`${T}.confirm.revoke_key_title`) : t(`${T}.confirm.revoke_integration_title`)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isKey ? t(`${T}.confirm.revoke_key_description`) : t(`${T}.confirm.revoke_integration_description`)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t(`${T}.form.cancel`)}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
            disabled={isPending}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t(`${T}.confirm.confirm_revoke`)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── List ───────────────────────────────────────────────────────────────────

function KeyRow({
  apiKey,
  canRevoke,
  onRevoke,
}: {
  apiKey: ApiKeySummary;
  canRevoke: boolean;
  onRevoke: () => void;
}) {
  const { t, i18n } = useTranslation();
  const expires = formatDate(apiKey.expiresAt, i18n.language) ?? t(`${T}.no_expiry`);
  const lastUsed = formatDate(apiKey.lastUsedAt, i18n.language) ?? t(`${T}.never_used`);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid="api-key-row">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{apiKey.name}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            bliss_{apiKey.prefix}_…
          </code>
          <StatusBadge status={apiKey.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          {t(`${T}.expires`)}: {expires} · {t(`${T}.last_used`)}: {lastUsed}
        </p>
      </div>
      {canRevoke && apiKey.status === 'active' && (
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onRevoke}>
          {t(`${T}.revoke_key`)}
        </Button>
      )}
    </li>
  );
}

function IntegrationRow({
  integration,
  onAddKey,
  onRename,
  onRevoke,
  onRevokeKey,
}: {
  integration: Integration;
  onAddKey: () => void;
  onRename: () => void;
  onRevoke: () => void;
  onRevokeKey: (key: ApiKeySummary) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const isActive = integration.status === 'active';
  const lastUsed = formatDate(integration.lastUsedAt, i18n.language) ?? t(`${T}.never_used`);

  return (
    <li className="px-7 py-4" data-testid="integration-row">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{integration.name}</span>
            <AccessBadge level={integration.accessLevel} />
            <StatusBadge status={integration.status} />
          </div>
          {integration.description && (
            <p className="text-xs text-muted-foreground">{integration.description}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {t(`${T}.keys_count`, { count: integration.activeKeyCount, total: integration.keyCount })} ·{' '}
            {t(`${T}.last_used`)}: {lastUsed}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {isActive && (
            <>
              <Button variant="outline" size="sm" onClick={onAddKey}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t(`${T}.add_key`)}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRename} aria-label={t(`${T}.rename`)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={onRevoke}
                aria-label={t(`${T}.revoke_integration`)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp className="mr-1 h-3.5 w-3.5" /> : <ChevronDown className="mr-1 h-3.5 w-3.5" />}
            {expanded ? t(`${T}.hide_keys`) : t(`${T}.show_keys`)}
          </Button>
        </div>
      </div>
      {expanded && (
        <ul className="mt-2 divide-y divide-border border-t border-border">
          {integration.keys.map((key) => (
            <KeyRow key={key.id} apiKey={key} canRevoke={isActive} onRevoke={() => onRevokeKey(key)} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── Tab ────────────────────────────────────────────────────────────────────

export function IntegrationsTab() {
  const { t } = useTranslation();
  const { data: integrations, isLoading, isError } = useIntegrations();

  const [createOpen, setCreateOpen] = useState(false);
  const [addKeyFor, setAddKeyFor] = useState<Integration | null>(null);
  const [renameFor, setRenameFor] = useState<Integration | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<PendingRevoke | null>(null);

  return (
    <>
      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex flex-col gap-3 px-7 pt-[22px] pb-[18px] sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-lg font-medium text-foreground tracking-[-0.01em]">{t(`${T}.title`)}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t(`${T}.description`)}</p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            {t(`${T}.create`)}
          </Button>
        </div>

        <div className="border-t border-border">
          {isLoading ? (
            <div className="space-y-3 px-7 py-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : isError ? (
            <p className="px-7 py-5 text-sm text-destructive">{t(`${T}.loading_error`)}</p>
          ) : !integrations || integrations.length === 0 ? (
            <p className="px-7 py-5 text-sm text-muted-foreground">{t(`${T}.empty`)}</p>
          ) : (
            <ul className="divide-y divide-border">
              {integrations.map((integration) => (
                <IntegrationRow
                  key={integration.id}
                  integration={integration}
                  onAddKey={() => setAddKeyFor(integration)}
                  onRename={() => setRenameFor(integration)}
                  onRevoke={() => setPendingRevoke({ kind: 'integration', integration })}
                  onRevokeKey={(key) => setPendingRevoke({ kind: 'key', integration, key })}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-1.5 border-t border-border bg-muted/40 px-7 py-4 text-xs text-muted-foreground">
          <p>{t(`${T}.acting_note`)}</p>
          <p>{t(`${T}.security_note`)}</p>
        </div>
      </Card>

      <CreateIntegrationDialog open={createOpen} onOpenChange={setCreateOpen} />
      <AddKeyDialog integration={addKeyFor} onOpenChange={(open) => !open && setAddKeyFor(null)} />
      <RenameDialog integration={renameFor} onOpenChange={(open) => !open && setRenameFor(null)} />
      <RevokeConfirmDialog pending={pendingRevoke} onOpenChange={(open) => !open && setPendingRevoke(null)} />
    </>
  );
}
