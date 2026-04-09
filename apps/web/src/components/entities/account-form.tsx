import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import api from '@/lib/api';
import { getTenantMeta } from '@/utils/tenantMetaStorage';
import type { Account, Bank, Country, Currency, User } from '@/types/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/use-auth';
import { Checkbox } from '../ui/checkbox';


// Form schema
const accountSchema = z.object({
  name: z.string().min(2, { message: 'Account name must be at least 2 characters' }),
  accountNumber: z.string().min(4, { message: 'Account number is required' }),
  bankId: z.string().min(1, { message: 'Bank name is required' }),
  currencyCode: z.string().min(1, { message: 'Currency is required' }),
  countryId: z.string().min(1, { message: 'Country is required' }),
  ownerIds: z.array(z.string()).min(1, { message: 'Select at least one owner' }),
});

const transformedAccountSchema = accountSchema.extend({
  bankId: z.string().transform(Number),
});

type AccountFormValues = z.infer<typeof accountSchema>;

interface AccountFormProps {
  account: Account | null;
  onClose: (refetchNeeded?: boolean) => void;
}

export function AccountForm({ account, onClose }: AccountFormProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Get tenant metadata from localStorage
  const tenantMeta = getTenantMeta();
  const banks: Bank[] = tenantMeta?.banks || [];
  const currencies: Currency[] = tenantMeta?.currencies || [];
  const countries: Country[] = tenantMeta?.countries || [];

  const tenantId = (currentUser as any)?.tenant?.id || currentUser?.tenantId;
  const { data: users = [], isLoading: usersLoading } = useQuery<User[]>({
    queryKey: ['users', tenantId],
    queryFn: () => api.getUsers(),
    enabled: !!tenantId,
  });


  // Initialize form with account data or empty values
  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      name: account?.name || '',
      accountNumber: account?.accountNumber || '',
      bankId: account?.bankId?.toString() || (banks[0]?.id?.toString() ?? ''),
      currencyCode: account?.currencyCode || (currencies[0]?.id ?? ''),
      countryId: account?.countryId || (countries[0]?.id ?? ''),
      ownerIds: account?.owners?.map(o => o.userId) || (currentUser ? [currentUser.id] : []),
    },
  });

  const onSubmit = async (values: AccountFormValues) => {
    setIsSubmitting(true);
    try {
      const transformedValues = transformedAccountSchema.parse(values);
      if (account) {
        await api.updateAccount(account.id, transformedValues);
        toast({
          title: t('accountForm.accountUpdated'),
          description: t('accountForm.accountUpdatedSuccess'),
        });
      } else {
        await api.createAccount(transformedValues);
        toast({
          title: t('accountForm.accountCreated'),
          description: t('accountForm.accountCreatedSuccess', { name: values.name }),
        });
      }
      // Invalidate both the combined metadata query and the dedicated accounts query.
      // The combined ['metadata'] key is what useMetadata() uses (transactions page),
      // and ['metadata', 'accounts'] is what useAccounts() uses (smart-import page).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['metadata'] }),
        queryClient.invalidateQueries({ queryKey: ['metadata', 'accounts'] }),
      ]);
      onClose(true);
    } catch (error) {
      toast({
        title: t('common.error'),
        description: account
          ? t('accountForm.updateError')
          : t('accountForm.createError'),
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('accountForm.accountName')}</FormLabel>
              <FormControl>
                <Input placeholder="e.g. Primary Checking, Savings, Credit Card" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="accountNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('accountForm.accountNumber')}</FormLabel>
              <FormControl>
                <Input placeholder="Last 4 or full account number" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="ownerIds"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('accountForm.owners')}</FormLabel>
              {usersLoading ? (
                <div>{t('ui.loading')}</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {users.map((user) => (
                    <div key={user.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`user-${user.id}`}
                        value={user.id}
                        checked={field.value.includes(user.id)}
                        onCheckedChange={(checked) => {
                          return checked
                            ? field.onChange([...field.value, user.id])
                            : field.onChange(field.value.filter((id: string) => id !== user.id));
                        }}
                      />
                      <label htmlFor={`user-${user.id}`} className="cursor-pointer">
                        {user.email}
                      </label>
                    </div>
                  ))}
                </div>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex flex-col md:flex-row gap-4">
          <FormField
            control={form.control}
            name="bankId"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>{t('accountForm.bank')}</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t('accountForm.selectBank')} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {banks.map((bank) => (
                      <SelectItem key={bank.id} value={bank.id.toString()}>
                        {bank.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="currencyCode"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>{t('accountForm.currency')}</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t('accountForm.selectCurrency')} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {currencies.map((currency) => (
                      <SelectItem key={currency.id} value={currency.id}>
                        {currency.name} {currency.symbol ? `(${currency.symbol})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="countryId"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>{t('accountForm.country')}</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t('accountForm.selectCountry')} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {countries.map((country) => (
                      <SelectItem key={country.id} value={country.id}>
                        {country.emoji ? `${country.emoji} ` : ''}{country.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="outline" onClick={() => onClose()}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : account ? t('accountForm.updateAccount') : t('accountForm.createAccount')}
          </Button>
        </div>
      </form>
    </Form>
  );
}