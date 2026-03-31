import { CreditCard, PlusIcon, Wallet, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useTranslation } from 'react-i18next';

type AccountData = {
  id: string;
  name: string;
  institution: string;
  country: string;
  currency: string;
};

interface AccountsListProps {
  accounts: AccountData[];
}

export function AccountsList({ accounts }: AccountsListProps) {
  const { t } = useTranslation();
  
  return (
    <Card>
      <CardHeader className="px-6 pt-6 pb-0">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('pages.accounts.title')}
          </h3>
          <Button
            type="button"
            variant="link"
            className="text-primary-500 hover:text-primary-600 dark:text-primary-300 dark:hover:text-primary-200 text-sm font-medium"
          >
            {t('dashboard.viewAll')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-6">
        <div className="space-y-4">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg"
            >
              <div className="flex items-center">
                <div
                  className={`flex-shrink-0 h-10 w-10 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700`}
                >
                  <Wallet className="h-6 w-6 text-gray-500 dark:text-gray-300" />
                </div>
                <div className="ml-3">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {account.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {account.institution}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold text-gray-900 dark:text-white">
                  {account.country}
                  {account.currency ? ` (${account.currency})` : ''}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-6">
          <Button
            type="button"
            variant="outline"
            className="w-full flex justify-center items-center"
          >
            <PlusIcon className="h-5 w-5 mr-2 text-gray-400" />
            {t('pages.accounts.addAccount')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
