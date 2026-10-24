import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useToast } from '@/hooks/use-toast';
import { etoroError, useConvertToCopyTrading, useEtoroConnections } from '@/hooks/use-etoro';
import { MOBILE_SHEET_CLASSES } from '@/lib/manage-assets';
import { copyCandidatesFor, isValidEtoroUsername, matchCopyFromName, normalizeEtoroUsername } from '@/lib/etoro';
import { cn, formatCurrency } from '@/lib/utils';

const KNOWN_ERRORS = new Set(['INVALID_USERNAME', 'COPY_HOLDING_EXISTS', 'COPY_TRADING_CATEGORY_MISSING']);
/** Radio value for "type another username". */
const OTHER = '__other__';

interface ConvertToCopyTradingModalProps {
  asset: { id: number; symbol: string; accountId?: number | null } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Switch to Copy Trading" (#143, R8): moves a holding — typically a manual
 * Fund recorded as "copy of @x" — to the Copy Trading category in place.
 * Transactions, income terms and history are kept.
 *
 * Once eToro is connected, the user picks one of the account's unlinked copies
 * (preselected when the holding's name contains the investor's username), so
 * nobody has to type usernames; "Another investor" keeps the free-text field.
 */
export function ConvertToCopyTradingModal({ asset, open, onOpenChange }: ConvertToCopyTradingModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const convert = useConvertToCopyTrading();
  const { data: connections } = useEtoroConnections(open);
  const [choice, setChoice] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { candidates, otherAccount } = useMemo(
    () => copyCandidatesFor(connections, asset?.accountId),
    [connections, asset?.accountId],
  );
  const suggested = useMemo(
    () => (asset ? matchCopyFromName(asset.symbol, candidates.map((c) => c.parentUsername)) : null),
    [asset, candidates],
  );

  // Start each holding from its suggestion (or the first copy) once the copies are known.
  useEffect(() => {
    setChoice(null);
    setUsername('');
    setError(null);
  }, [asset?.id]);
  useEffect(() => {
    if (choice === null && candidates.length > 0) setChoice(suggested ?? candidates[0].parentUsername);
  }, [choice, candidates, suggested]);

  const picking = candidates.length > 0 && choice !== OTHER;
  const typed = picking ? choice ?? '' : username;
  const normalized = normalizeEtoroUsername(typed);
  const valid = isValidEtoroUsername(typed);

  const submit = () => {
    if (!asset || !valid) return;
    setError(null);
    convert.mutate(
      { portfolioItemId: asset.id, etoroUsername: normalized },
      {
        onSuccess: (data) => {
          toast({ title: t('etoro.convert.success', { symbol: data.symbol }) });
          setUsername('');
          setChoice(null);
          onOpenChange(false);
        },
        onError: (err) => {
          const code = etoroError(err).body.code;
          setError(code && KNOWN_ERRORS.has(code) ? code : 'generic');
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`sm:max-w-md ${MOBILE_SHEET_CLASSES}`} data-testid="convert-copy-trading-modal">
        <DialogHeader>
          <DialogTitle>{t('etoro.convert.title')}</DialogTitle>
          <DialogDescription>{t('etoro.convert.description', { symbol: asset?.symbol ?? '' })}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {otherAccount && (
            <p className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning" data-testid="convert-other-account">
              {t('etoro.convert.otherAccount', { account: otherAccount.account?.name ?? '' })}
            </p>
          )}
          {candidates.length > 0 && (
            <div className="space-y-1.5">
              <Label id="etoro-copy-label">{t('etoro.convert.pickCopy')}</Label>
              <RadioGroup
                aria-labelledby="etoro-copy-label"
                value={choice ?? ''}
                onValueChange={setChoice}
                className="max-h-64 gap-1.5 overflow-y-auto"
              >
                {[...candidates.map((c) => c.parentUsername), OTHER].map((value) => {
                  const copy = candidates.find((c) => c.parentUsername === value);
                  const id = `etoro-copy-${value}`;
                  return (
                    <label
                      key={value}
                      htmlFor={id}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm transition-colors',
                        choice === value && 'border-brand-primary bg-brand-primary/5',
                      )}
                    >
                      <RadioGroupItem id={id} value={value} />
                      {copy ? (
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                          <span className="truncate font-medium text-brand-deep">@{copy.parentUsername}</span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {copy.lastValue != null ? formatCurrency(copy.lastValue, copy.lastValueCurrency) : ''}
                            {copy.parentUsername === suggested && ` · ${t('etoro.convert.matched')}`}
                          </span>
                        </span>
                      ) : (
                        <span>{t('etoro.convert.otherInvestor')}</span>
                      )}
                    </label>
                  );
                })}
              </RadioGroup>
            </div>
          )}
          {!picking && (
            <div className="space-y-1.5">
              <Label htmlFor="etoro-username">{t('etoro.convert.username')}</Label>
              <Input
                id="etoro-username"
                value={username}
                autoComplete="off"
                placeholder={t('etoro.convert.usernamePlaceholder')}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {t(`etoro.convert.errors.${error}`)}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('etoro.dialog.cancel')}</Button>
            <Button type="submit" disabled={!valid || convert.isPending}>
              {convert.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('etoro.convert.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
