import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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

interface AddBankDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => Promise<void>;
  isSubmitting: boolean;
}

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 100;

export function AddBankDialog({ open, onOpenChange, onConfirm, isSubmitting }: AddBankDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setName('');
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  const handleConfirm = async () => {
    const trimmed = name.trim();
    if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_NAME_LENGTH) {
      setError(t('addBankDialog.validationError'));
      return;
    }
    setError(null);
    try {
      await onConfirm(trimmed);
      setName('');
    } catch {
      // Parent already surfaces the error toast; keep the dialog open with the typed name.
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void handleConfirm();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('addBankDialog.title')}</DialogTitle>
          <DialogDescription>{t('addBankDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="add-bank-name">{t('addBankDialog.nameLabel')}</Label>
          <Input
            id="add-bank-name"
            value={name}
            placeholder={t('addBankDialog.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting}
            autoFocus
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
          >
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
