import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { AccountForm } from '@/components/entities/account-form';
import type { Account } from '@/types/api';

interface AddAccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: Account | null;
  onClose: (refetchNeeded?: boolean) => void;
}

export function AddAccountModal({ open, onOpenChange, account, onClose }: AddAccountModalProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {account ? t('accountModal.editTitle') : t('accountModal.addTitle')}
          </DialogTitle>
          <DialogDescription>
            {account
              ? t('accountModal.editDescription')
              : t('accountModal.addDescription')}
          </DialogDescription>
        </DialogHeader>
        <AccountForm
          account={account ?? undefined}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
