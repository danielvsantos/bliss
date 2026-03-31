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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {account ? 'Edit Account' : 'Add Manual Account'}
          </DialogTitle>
          <DialogDescription>
            {account
              ? 'Update your account details.'
              : 'Add a new manually-tracked account.'}
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
