import { useState } from 'react';
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
import { useToast } from '@/hooks/use-toast';
import { etoroError, useConvertToCopyTrading } from '@/hooks/use-etoro';
import { MOBILE_SHEET_CLASSES } from '@/lib/manage-assets';
import { isValidEtoroUsername, normalizeEtoroUsername } from '@/lib/etoro';

const KNOWN_ERRORS = new Set(['INVALID_USERNAME', 'COPY_HOLDING_EXISTS', 'COPY_TRADING_CATEGORY_MISSING']);

interface ConvertToCopyTradingModalProps {
  asset: { id: number; symbol: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Switch to Copy Trading" (#143, R8): moves a holding — typically a manual
 * Fund recorded as "copy of @x" — to the Copy Trading category in place.
 * Transactions, income terms and history are kept.
 */
export function ConvertToCopyTradingModal({ asset, open, onOpenChange }: ConvertToCopyTradingModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const convert = useConvertToCopyTrading();
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizeEtoroUsername(username);
  const valid = isValidEtoroUsername(username);

  const submit = () => {
    if (!asset || !valid) return;
    setError(null);
    convert.mutate(
      { portfolioItemId: asset.id, etoroUsername: normalized },
      {
        onSuccess: (data) => {
          toast({ title: t('etoro.convert.success', { symbol: data.symbol }) });
          setUsername('');
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
