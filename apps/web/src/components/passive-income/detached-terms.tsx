import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronsUpDown, Link2, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
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
import { useToast } from '@/hooks/use-toast';
import { useAttachIncomeTerms, useDiscardIncomeTerms } from '@/hooks/use-passive-income';
import { usePortfolioItems } from '@/hooks/use-portfolio-items';
import { canHoldIncomeTerms } from '@/lib/passive-income';
import { parseDecimal } from '@/lib/portfolio-utils';
import { formatDate } from '@/lib/utils';
import type { DetachedIncomeTerms } from '@/types/passive-income';

/**
 * Detached income terms (R1.10): terms kept when a rebuild re-keyed their
 * asset (a corrected import) and no single clear match existed. Shown only
 * when there are some. Re-attach to an asset without terms, or discard.
 */
export function DetachedTermsSection({ detached }: { detached: DetachedIncomeTerms[] }) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const locale = i18n.language || 'en-US';
  const [attachingId, setAttachingId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<string>('');
  const [discardId, setDiscardId] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const attach = useAttachIncomeTerms();
  const discard = useDiscardIncomeTerms();

  // Only fetched once the user starts re-attaching.
  const { data: portfolio } = usePortfolioItems({ enabled: attachingId !== null });
  const candidates = useMemo(
    () => (portfolio?.items ?? [])
      .filter((i) => canHoldIncomeTerms(i.category) && !i.incomeTerms && parseDecimal(i.quantity) > 0)
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [portfolio?.items],
  );

  const selected = candidates.find((c) => String(c.id) === targetId);
  const selectedLabel = selected ? `${selected.symbol}${selected.account?.name ? ` · ${selected.account.name}` : ''}` : '';

  if (detached.length === 0) return null;

  const doAttach = async (id: number) => {
    if (!targetId) return;
    try {
      await attach.mutateAsync({ id, assetId: Number(targetId) });
      toast({ title: t('passiveIncome.detached.attached') });
      setAttachingId(null);
      setTargetId('');
    } catch {
      toast({ title: t('common.error'), description: t('passiveIncome.detached.attachFailed'), variant: 'destructive' });
    }
  };

  const doDiscard = async () => {
    if (discardId == null) return;
    try {
      await discard.mutateAsync(discardId);
      toast({ title: t('passiveIncome.detached.discarded') });
    } catch {
      toast({ title: t('common.error'), description: t('passiveIncome.detached.discardFailed'), variant: 'destructive' });
    } finally {
      setDiscardId(null);
    }
  };

  return (
    <Card className="border-warning/30" data-testid="detached-terms">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t('passiveIncome.detached.title')}</CardTitle>
        <CardDescription>{t('passiveIncome.detached.description')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {detached.map((d) => (
          <div key={d.id} className="rounded-md border border-gray-200 p-3 space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-brand-deep break-words">{d.orphanedLabel || t('passiveIncome.detached.unnamed')}</p>
                <p className="text-xs text-muted-foreground">
                  {t(`passiveIncome.incomeType.${d.incomeType}`)} · {t('passiveIncome.detached.detachedOn', { date: formatDate(d.orphanedAt, undefined, locale) })}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={() => { setAttachingId(d.id); setTargetId(''); }}>
                  <Link2 className="h-3.5 w-3.5" />
                  {t('passiveIncome.detached.reattach')}
                </Button>
                <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 text-destructive" onClick={() => setDiscardId(d.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('passiveIncome.detached.discard')}
                </Button>
              </div>
            </div>
            {attachingId === d.id && (
              <div className="flex flex-col sm:flex-row gap-2">
                {/* Searchable: a large portfolio can have 100+ candidate holdings. */}
                <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={pickerOpen}
                      aria-label={t('passiveIncome.detached.pickAsset')}
                      className="sm:flex-1 justify-between font-normal min-w-0"
                    >
                      <span className="truncate">
                        {selectedLabel || <span className="text-muted-foreground">{t('passiveIncome.detached.pickAsset')}</span>}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="p-0 w-[--radix-popover-trigger-width] min-w-[240px]" align="start">
                    <Command>
                      <CommandInput placeholder={t('passiveIncome.detached.searchAsset')} />
                      <CommandList>
                        <CommandEmpty>{t('passiveIncome.detached.noAssets')}</CommandEmpty>
                        <CommandGroup>
                          {candidates.map((c) => {
                            const label = `${c.symbol}${c.account?.name ? ` · ${c.account.name}` : ''}`;
                            return (
                              <CommandItem
                                key={c.id}
                                value={`${label} ${c.id}`}
                                onSelect={() => {
                                  setTargetId(String(c.id));
                                  setPickerOpen(false);
                                }}
                              >
                                <Check className={cn('mr-2 h-4 w-4', targetId === String(c.id) ? 'opacity-100' : 'opacity-0')} />
                                <span className="truncate">{label}</span>
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => doAttach(d.id)} disabled={!targetId || attach.isPending}>
                    {t('passiveIncome.detached.confirmAttach')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAttachingId(null)}>{t('common.cancel')}</Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </CardContent>

      <AlertDialog open={discardId !== null} onOpenChange={(open) => !open && setDiscardId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('passiveIncome.detached.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('passiveIncome.detached.discardConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={doDiscard}>{t('passiveIncome.detached.discard')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
