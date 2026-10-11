import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, ArrowRightLeft, CalendarDays, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  enableBankingError,
  useEnableBankingConnection,
  useMapEnableBankingConnection,
} from '@/hooks/use-enable-banking';
import { metadataKeys } from '@/hooks/use-metadata';
import { formatBalance, formatDate, formatIsoDay } from '@/lib/enable-banking';
import { getTenantMeta } from '@/utils/tenantMetaStorage';
import api from '@/lib/api';
import type {
  Bank,
  Country,
  Currency,
  EnableBankingBankAccount,
  EnableBankingBlissAccount,
  EnableBankingMapping,
  EnableBankingSwitchAccount,
} from '@/types/api';

interface EnableBankingMappingDialogProps {
  /** The Enable Banking connection (PlaidItem id) to map; null keeps the dialog closed. */
  connectionId: string | null;
  onClose: () => void;
}

/** `acc:<id>` (existing Bliss account), `create` (new account) or `skip` (don't sync). */
type Choice = string;
const SKIP = 'skip';
const CREATE = 'create';
/** Bank select value meaning "add the connection's institution as a new bank". */
const NEW_BANK = 'new';

interface CreateDraft {
  name: string;
  bankId: string;
  countryId: string;
  currencyCode: string;
}

function readTenantMeta(): { banks: Bank[]; countries: Country[]; currencies: Currency[] } {
  try {
    const meta = getTenantMeta();
    return { banks: meta?.banks ?? [], countries: meta?.countries ?? [], currencies: meta?.currencies ?? [] };
  } catch {
    return { banks: [], countries: [], currencies: [] };
  }
}

function defaultChoice(acc: EnableBankingBankAccount): Choice {
  // "Create new account" is never the default: an unmatched bank account is skipped
  // until the user picks a target.
  if (acc.conflict) return SKIP;
  return acc.suggestedAccountId != null ? `acc:${acc.suggestedAccountId}` : SKIP;
}

export function EnableBankingMappingDialog({ connectionId, onClose }: EnableBankingMappingDialogProps) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useEnableBankingConnection(connectionId);
  const mapAccounts = useMapEnableBankingConnection();

  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [drafts, setDrafts] = useState<Record<string, CreateDraft>>({});
  const [switchAccounts, setSwitchAccounts] = useState<EnableBankingSwitchAccount[] | null>(null);
  const [isCreatingBank, setIsCreatingBank] = useState(false);
  const tenant = useMemo(readTenantMeta, []);

  const institutionName = data?.connection.institutionName ?? '';
  const matchingBank = tenant.banks.find(
    (b) => institutionName && b.name.trim().toLowerCase() === institutionName.trim().toLowerCase(),
  );

  // Initialise choices once per loaded connection.
  useEffect(() => {
    if (!data) return;
    const next: Record<string, Choice> = {};
    for (const acc of data.accounts) next[acc.id] = defaultChoice(acc);
    setChoices(next);
    setDrafts({});
    setSwitchAccounts(null);
  }, [data]);

  const blissById = useMemo(
    () => new Map((data?.blissAccounts ?? []).map((b) => [b.id, b])),
    [data],
  );

  const draftFor = (acc: EnableBankingBankAccount): CreateDraft => {
    if (drafts[acc.id]) return drafts[acc.id];
    const fallbackCurrency = tenant.currencies.find((c) => c.isDefault) ?? tenant.currencies[0];
    const country = tenant.countries.find((c) => c.isDefault) ?? tenant.countries[0];
    return {
      name: acc.name || institutionName,
      bankId: matchingBank ? String(matchingBank.id) : institutionName ? NEW_BANK : String(tenant.banks[0]?.id ?? ''),
      countryId: country?.id ?? '',
      // The bank account's own currency wins; it is offered even when the tenant lacks it.
      currencyCode: acc.currency || (fallbackCurrency?.id ?? ''),
    };
  };

  const updateDraft = (acc: EnableBankingBankAccount, patch: Partial<CreateDraft>) => {
    setDrafts((prev) => ({ ...prev, [acc.id]: { ...draftFor(acc), ...patch } }));
  };

  const linkHint = (b: EnableBankingBlissAccount) => {
    if (b.linkedProvider === 'PLAID') return t('enableBanking.mapping.linkedPlaid');
    if (b.linkedProvider === 'ENABLE_BANKING') return t('enableBanking.mapping.linkedEnableBanking');
    return null;
  };

  const rows = data?.accounts ?? [];
  const mappableRows = rows.filter((acc) => !acc.conflict);

  const buildMappings = async (): Promise<EnableBankingMapping[] | null> => {
    let newBankId: number | null = null;
    const mappings: EnableBankingMapping[] = [];
    for (const acc of mappableRows) {
      const choice = choices[acc.id] ?? SKIP;
      if (choice === SKIP) {
        mappings.push({ ebAccountId: acc.id, skip: true });
      } else if (choice === CREATE) {
        const draft = draftFor(acc);
        if (!draft.name.trim() || !draft.bankId || !draft.countryId || !draft.currencyCode) {
          toast({ title: t('common.error'), description: t('enableBanking.mapping.errorCreateIncomplete'), variant: 'destructive' });
          return null;
        }
        let bankId = Number(draft.bankId);
        if (draft.bankId === NEW_BANK) {
          if (newBankId === null) {
            setIsCreatingBank(true);
            try {
              newBankId = (await api.createBank({ name: institutionName })).id;
              queryClient.invalidateQueries({ queryKey: metadataKeys.all });
            } finally {
              setIsCreatingBank(false);
            }
          }
          bankId = newBankId;
        }
        mappings.push({
          ebAccountId: acc.id,
          create: { name: draft.name.trim(), bankId, countryId: draft.countryId, currencyCode: draft.currencyCode },
        });
      } else {
        mappings.push({ ebAccountId: acc.id, accountId: Number(choice.slice(4)) });
      }
    }
    return mappings;
  };

  const submit = async (confirmProviderSwitch: boolean) => {
    if (!connectionId) return;
    let mappings: EnableBankingMapping[] | null;
    try {
      mappings = await buildMappings();
    } catch {
      toast({ title: t('common.error'), description: t('enableBanking.mapping.errorGeneric'), variant: 'destructive' });
      return;
    }
    if (!mappings || mappings.length === 0) return;

    mapAccounts.mutate(
      { id: connectionId, data: { mappings, ...(confirmProviderSwitch && { confirmProviderSwitch: true }) } },
      {
        onSuccess: (result) => {
          const linked = result.mapped + result.created;
          toast({
            title: t('enableBanking.mapping.successTitle'),
            description: linked > 0
              ? t('enableBanking.mapping.successDesc', { count: linked })
              : t('enableBanking.mapping.successNoneDesc'),
          });
          onClose();
        },
        onError: (error) => {
          const { body } = enableBankingError(error);
          if (body.code === 'PROVIDER_SWITCH_REQUIRED' && Array.isArray(body.accounts)) {
            setSwitchAccounts(body.accounts);
            return;
          }
          const description = body.code === 'ACCOUNT_ALREADY_CONNECTED'
            ? t('enableBanking.mapping.errorAlreadyConnected')
            : body.code === 'DUPLICATE_TARGET'
              ? t('enableBanking.mapping.errorDuplicate')
              : t('enableBanking.mapping.errorGeneric');
          toast({ title: t('common.error'), description, variant: 'destructive' });
        },
      },
    );
  };

  const busy = mapAccounts.isPending || isCreatingBank;
  const providerLabel = (provider: string) =>
    provider === 'ENABLE_BANKING' ? t('enableBanking.mapping.providerEnableBanking') : t('enableBanking.mapping.providerPlaid');

  return (
    <Dialog open={!!connectionId} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        {switchAccounts ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('enableBanking.mapping.switchTitle')}</DialogTitle>
              <DialogDescription>{t('enableBanking.mapping.switchDesc')}</DialogDescription>
            </DialogHeader>
            <ul className="space-y-2" data-testid="eb-switch-list">
              {switchAccounts.map((a) => (
                <li key={a.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
                  <ArrowRightLeft className="h-4 w-4 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{a.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('enableBanking.mapping.switchFrom', {
                        provider: providerLabel(a.provider),
                        bank: a.institutionName ?? '—',
                      })}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSwitchAccounts(null)} disabled={busy}>
                {t('common.back')}
              </Button>
              <Button onClick={() => submit(true)} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('enableBanking.mapping.switchConfirm')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('enableBanking.mapping.title')}</DialogTitle>
              <DialogDescription>
                {t('enableBanking.mapping.description', { bank: institutionName })}
              </DialogDescription>
            </DialogHeader>

            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('enableBanking.mapping.loading')}
              </div>
            ) : isError || !data ? (
              <p className="py-6 text-sm text-destructive">{t('enableBanking.mapping.loadFailed')}</p>
            ) : (
              <div className="space-y-4">
                <div
                  className="flex items-start gap-2 rounded-lg border border-brand-primary/20 bg-brand-primary/5 p-3 text-sm"
                  data-testid="eb-start-date"
                >
                  <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary" />
                  <p>
                    {t('enableBanking.connect.startDate')}{' '}
                    <strong>{formatIsoDay(data.startDate, language)}</strong>
                  </p>
                </div>

                {rows.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t('enableBanking.mapping.noAccounts')}</p>
                )}

                {rows.map((acc) => {
                  const choice = choices[acc.id] ?? defaultChoice(acc);
                  const takenElsewhere = new Set(
                    Object.entries(choices)
                      .filter(([id, c]) => id !== acc.id && c.startsWith('acc:'))
                      .map(([, c]) => c),
                  );
                  const target = choice.startsWith('acc:') ? blissById.get(Number(choice.slice(4))) : undefined;
                  const draft = choice === CREATE ? draftFor(acc) : null;
                  return (
                    <div
                      key={acc.id}
                      className={`rounded-lg border p-3 space-y-3 ${acc.conflict ? 'bg-muted/50' : ''}`}
                      data-testid={`eb-map-row-${acc.id}`}
                      data-choice={choice}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{acc.name || t('enableBanking.mapping.unnamed')}</p>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {acc.ibanLast4 && <span className="font-mono">•••• {acc.ibanLast4}</span>}
                            {acc.currency && <Badge variant="outline" className="text-[10px] px-1.5 py-0">{acc.currency}</Badge>}
                            {acc.lastBalance !== null && (
                              <span>
                                {t('enableBanking.mapping.balance', {
                                  amount: formatBalance(acc.lastBalance, acc.lastBalanceCurrency ?? acc.currency, language),
                                })}
                                {acc.lastBalanceAt && ` · ${formatDate(acc.lastBalanceAt, language)}`}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="w-full sm:w-64 shrink-0">
                          <Select
                            value={choice}
                            onValueChange={(value) => setChoices((prev) => ({ ...prev, [acc.id]: value }))}
                            disabled={acc.conflict || busy}
                          >
                            <SelectTrigger aria-label={t('enableBanking.mapping.syncInto')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {data.blissAccounts.length > 0 && (
                                <SelectGroup>
                                  <SelectLabel>{t('enableBanking.mapping.existingAccounts')}</SelectLabel>
                                  {data.blissAccounts.map((b) => {
                                    const value = `acc:${b.id}`;
                                    const hint = linkHint(b);
                                    return (
                                      <SelectItem key={b.id} value={value} disabled={takenElsewhere.has(value)}>
                                        {b.name}
                                        {b.last4 ? ` •••• ${b.last4}` : ''} · {b.currencyCode}
                                        {hint ? ` (${hint})` : ''}
                                      </SelectItem>
                                    );
                                  })}
                                </SelectGroup>
                              )}
                              <SelectSeparator />
                              <SelectItem value={CREATE}>{t('enableBanking.mapping.createNew')}</SelectItem>
                              <SelectItem value={SKIP}>{t('enableBanking.mapping.dontSync')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {acc.conflict && (
                        <p className="flex items-start gap-2 text-xs text-warning" data-testid={`eb-conflict-${acc.id}`}>
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          {t('enableBanking.mapping.conflict')}
                        </p>
                      )}

                      {target?.linkedProvider && (
                        <p className="flex items-start gap-2 text-xs text-muted-foreground">
                          <ArrowRightLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                          {t('enableBanking.mapping.switchHint')}
                        </p>
                      )}

                      {draft && (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1 sm:col-span-2">
                            <Label htmlFor={`eb-name-${acc.id}`} className="text-xs">{t('enableBanking.mapping.newName')}</Label>
                            <Input
                              id={`eb-name-${acc.id}`}
                              value={draft.name}
                              maxLength={100}
                              onChange={(e) => updateDraft(acc, { name: e.target.value })}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">{t('enableBanking.mapping.newBank')}</Label>
                            <Select value={draft.bankId} onValueChange={(v) => updateDraft(acc, { bankId: v })}>
                              <SelectTrigger aria-label={t('enableBanking.mapping.newBank')}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {!matchingBank && institutionName && (
                                  <SelectItem value={NEW_BANK}>
                                    {t('enableBanking.mapping.createBankOption', { name: institutionName })}
                                  </SelectItem>
                                )}
                                {tenant.banks.map((b) => (
                                  <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">{t('enableBanking.mapping.newCountry')}</Label>
                            <Select value={draft.countryId} onValueChange={(v) => updateDraft(acc, { countryId: v })}>
                              <SelectTrigger aria-label={t('enableBanking.mapping.newCountry')}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {tenant.countries.map((c) => (
                                  <SelectItem key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ` : ''}{c.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">{t('enableBanking.mapping.newCurrency')}</Label>
                            <Select value={draft.currencyCode} onValueChange={(v) => updateDraft(acc, { currencyCode: v })}>
                              <SelectTrigger aria-label={t('enableBanking.mapping.newCurrency')}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {tenant.currencies.map((c) => (
                                  <SelectItem key={c.id} value={c.id}>{c.id}</SelectItem>
                                ))}
                                {acc.currency && !tenant.currencies.some((c) => c.id === acc.currency) && (
                                  <SelectItem value={acc.currency}>{acc.currency}</SelectItem>
                                )}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => submit(false)} disabled={busy || !data || mappableRows.length === 0}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {busy ? t('enableBanking.mapping.submitting') : t('enableBanking.mapping.submit')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
