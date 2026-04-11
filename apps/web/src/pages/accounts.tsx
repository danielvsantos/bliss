import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { PlusIcon, Landmark } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAccountList, accountListKeys } from '@/hooks/use-account-list';
import { AccountListPanel } from '@/components/accounts/account-list-panel';
import { AccountDetailPanel } from '@/components/accounts/account-detail-panel';
import { AddAccountModal } from '@/components/accounts/add-account-modal';
import { PlaidConnect } from '@/components/plaid-connect';
import type { Account } from '@/types/api';

export default function AccountsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { accounts, isLoading, refetch } = useAccountList();

  // Selection & modal state
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;

  // Refetch account list when window regains focus (catches post-Plaid-modal updates)
  useEffect(() => {
    const onFocus = () => {
      queryClient.invalidateQueries({ queryKey: accountListKeys.all });
      queryClient.invalidateQueries({ queryKey: accountListKeys.plaidItems() });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [queryClient]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleAddManual = () => {
    setEditAccount(null);
    setShowAddModal(true);
  };

  const handleEdit = () => {
    if (!selectedAccount) return;
    setEditAccount(selectedAccount.originalAccount);
    setShowAddModal(true);
  };

  const handleFormClose = useCallback(
    (refetchNeeded?: boolean) => {
      setShowAddModal(false);
      setEditAccount(null);
      if (refetchNeeded) refetch();
    },
    [refetch],
  );

  const handleDeleteConfirm = async () => {
    if (!selectedAccount) return;
    setIsDeleting(true);
    try {
      await api.deleteAccount(selectedAccount.id);
      toast({
        title: t('accountsPage.deleteSuccess'),
        description: t('accountsPage.deleteSuccessDetail', { name: selectedAccount.accountName }),
      });
      setShowDeleteConfirm(false);
      setSelectedAccountId(null);
      refetch();
    } catch {
      toast({ title: t('accountsPage.deleteFailed'), variant: 'destructive' });
    } finally {
      setIsDeleting(false);
    }
  };

  // ── Layout ──────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-6 py-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t('accountsPage.title')}</h1>
            <p className="text-sm text-muted-foreground">
              {t('accountsPage.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Uses PlaidConnect's built-in exchange + AccountSelectionModal flow */}
            <PlaidConnect variant="outline">
              <Landmark className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">{t('accountsPage.connectBank')}</span>
            </PlaidConnect>
            <Button onClick={handleAddManual}>
              <PlusIcon className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">{t('accountsPage.addManual')}</span>
            </Button>
          </div>
        </div>

        <Separator />

        {/* Master-Detail Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left — Account List */}
          <div className="w-[380px] shrink-0">
            <AccountListPanel
              accounts={accounts}
              selectedAccountId={selectedAccountId}
              onSelectAccount={setSelectedAccountId}
              isLoading={isLoading}
            />
          </div>

          {/* Right — Detail */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            {selectedAccount ? (
              <AccountDetailPanel
                account={selectedAccount}
                onEdit={handleEdit}
                onRefetch={refetch}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-10">
                <div className="bg-muted rounded-full p-4 mb-4">
                  <Landmark className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium">{t('accountsPage.selectAccount')}</h3>
                <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                  {t('accountsPage.selectAccountHint')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Add / Edit Account Modal */}
      <AddAccountModal
        open={showAddModal}
        onOpenChange={setShowAddModal}
        account={editAccount}
        onClose={handleFormClose}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('accountsPage.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('accountsPage.deleteConfirm', { name: selectedAccount?.accountName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
            >
              {isDeleting ? t('ui.deleting') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
