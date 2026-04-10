import { useState, useEffect, useMemo, useRef } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useToast } from '@/hooks/use-toast';
import { useAccounts, useCategories } from '@/hooks/use-metadata';
import { api } from '@/lib/api';
import { CalendarIcon } from 'lucide-react';
import { format } from 'date-fns';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Transaction as ApiTransaction } from '@/types/api';
import { DebtTermsForm } from './DebtTermsForm';
import { debtTermsSchema } from './debt-terms-schema';
import { useTickerSearch, type TickerResult } from '@/hooks/use-ticker-search';
import { CategoryCombobox } from './category-combobox';
import { TagInput } from './tag-input';

// Form schema
const transactionSchema = z.object({
  transaction_date: z.date({
    required_error: "Please select a date",
  }),
  description: z.string().min(2, { message: 'Description is required' }),
  details: z.string().optional(),
  credit: z.coerce.number().optional(),
  debit: z.coerce.number().optional(),
  currency: z.string({
    required_error: "Please select a currency",
  }),
  categoryId: z.coerce.number({ required_error: "Please select a category" }).positive({ message: 'Please select a category' }),
  accountId: z.coerce.number({ required_error: "Please select an account" }).positive({ message: 'Please select an account' }),
  assetQuantity: z.coerce.number().optional(),
  assetPrice: z.coerce.number().optional(),
  ticker: z.string().optional(),
  // Ticker resolution metadata (Sprint 14)
  isin: z.string().optional(),
  exchange: z.string().optional(),
  assetCurrency: z.string().optional(),
  tags: z.array(z.union([z.string(), z.number()])).optional(),
  debtTerms: debtTermsSchema.optional(),
});

type TransactionFormValues = z.infer<typeof transactionSchema>;

interface TransactionFormProps {
  transaction: ApiTransaction | null;
  onClose: (refetchNeeded?: boolean) => void;
}

function getDateComponents(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const quarter = Math.ceil(month / 3);
  return { year, quarter: `Q${quarter}`, month, day };
}

export function TransactionForm({ transaction, onClose }: TransactionFormProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [investmentAccordionValue, setInvestmentAccordionValue] = useState<string>(
    transaction?.category?.type === 'Investments' ? 'investment-details' : ''
  );

  // Ticker autocomplete state (Sprint 14)
  const [tickerSearchInput, setTickerSearchInput] = useState(transaction?.ticker ?? '');
  const [showTickerDropdown, setShowTickerDropdown] = useState(false);
  const tickerDropdownRef = useRef<HTMLDivElement>(null);

  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const { data: categories, isLoading: categoriesLoading } = useCategories();

  const isLoading = accountsLoading || categoriesLoading;

  const form = useForm<TransactionFormValues>({
    resolver: zodResolver(transactionSchema),
    defaultValues: transaction ? {
      ...transaction,
      transaction_date: new Date(transaction.transaction_date),
      credit: transaction.credit ?? undefined,
      debit: transaction.debit ?? undefined,
      details: (typeof transaction.details === 'object' && transaction.details ? JSON.stringify(transaction.details) : transaction.details) || '',
      assetQuantity: transaction.assetQuantity ?? undefined,
      assetPrice: transaction.assetPrice ?? undefined,
      ticker: transaction.ticker ?? undefined,
      isin: transaction.isin ?? undefined,
      exchange: transaction.exchange ?? undefined,
      assetCurrency: transaction.assetCurrency ?? undefined,
      tags: transaction.tags?.map(t => t.id) || [],
    } : {
      transaction_date: new Date(),
      description: '',
      credit: undefined,
      debit: undefined,
      currency: 'USD',
      categoryId: undefined,
      accountId: undefined,
      assetQuantity: undefined,
      assetPrice: undefined,
      ticker: undefined,
      isin: undefined,
      exchange: undefined,
      assetCurrency: undefined,
      details: '',
      tags: [],
      debtTerms: undefined,
    },
  });

  const selectedAccountId = useWatch({ control: form.control, name: 'accountId' });
  const selectedCategoryId = useWatch({ control: form.control, name: 'categoryId' });
  const debitValue = useWatch({ control: form.control, name: 'debit' });
  const creditValue = useWatch({ control: form.control, name: 'credit' });
  const assetPriceValue = useWatch({ control: form.control, name: 'assetPrice' });

  useEffect(() => {
    if (selectedAccountId) {
      const selectedAccount = accounts?.find(a => a.id === selectedAccountId);
      if (selectedAccount && form.getValues('currency') !== selectedAccount.currencyCode) {
        form.setValue('currency', selectedAccount.currencyCode);
      }
    }
  }, [selectedAccountId, accounts, form]);

  const selectedCategory = categories?.find(c => c.id === selectedCategoryId);
  const isInvestment = selectedCategory?.type === 'Investments';
  const isDebt = selectedCategory?.type === 'Debt';
  // Route crypto ticker searches to Twelve Data with crypto type filter
  const tickerSearchType = selectedCategory?.processingHint === 'API_CRYPTO' ? 'crypto' : undefined;
  const { data: tickerResults = [] } = useTickerSearch(tickerSearchInput, tickerSearchType);

  // Auto-open investment accordion when an investment category is selected
  useEffect(() => {
    if (isInvestment) {
      setInvestmentAccordionValue('investment-details');
    }
  }, [isInvestment]);

  // Sort data for dropdowns
  const sortedAccounts = useMemo(() => accounts?.slice().sort((a, b) => a.name.localeCompare(b.name)), [accounts]);

  useEffect(() => {
    const amount = debitValue || creditValue;
    if (isInvestment && amount && assetPriceValue && assetPriceValue > 0) {
      const quantity = amount / assetPriceValue;
      form.setValue('assetQuantity', quantity);
    }
  }, [debitValue, creditValue, assetPriceValue, isInvestment, form]);

  // Close ticker dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (tickerDropdownRef.current && !tickerDropdownRef.current.contains(e.target as Node)) {
        setShowTickerDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleTickerSelect = (result: TickerResult) => {
    const isCrypto = selectedCategory?.processingHint === 'API_CRYPTO';
    form.setValue('ticker', result.symbol);
    form.setValue('exchange', result.mic_code || result.exchange || undefined);
    // For crypto, use account currency (price pair determined by account, e.g. BTC/EUR)
    // For stocks/funds, use the asset's trading currency from search result
    form.setValue('assetCurrency', isCrypto ? selectedAccount?.currencyCode : (result.currency || undefined));
    // ISIN not available from symbol_search — will be resolved server-side
    form.setValue('isin', undefined);
    setTickerSearchInput(result.symbol);
    setShowTickerDropdown(false);
  };

  // Currency mismatch validation: block when assetCurrency ≠ account currency
  const watchedAssetCurrency = useWatch({ control: form.control, name: 'assetCurrency' });

  const onSubmit = async (values: TransactionFormValues) => {
    // Defense-in-depth: block currency mismatch on submit
    if (isInvestment && values.assetCurrency && selectedAccount && values.assetCurrency !== selectedAccount.currencyCode) {
      form.setError('ticker', {
        type: 'manual',
        message: t('transactionFormPage.currencyMismatch', { currency: values.assetCurrency }),
      });
      return;
    }
    setIsSubmitting(true);
    try {
      const dateComponents = getDateComponents(values.transaction_date);
      const transactionData = {
        ...values,
        transaction_date: `${values.transaction_date.getFullYear()}-${String(values.transaction_date.getMonth() + 1).padStart(2, '0')}-${String(values.transaction_date.getDate()).padStart(2, '0')}`,
        ...dateComponents,
      };

      if (transaction) {
        await api.updateTransaction(transaction.id, transactionData);
        toast({ title: t('common.success'), description: t('transactionFormPage.updatedSuccess') });
      } else {
        await api.createTransaction(transactionData);
        toast({ title: t('common.success'), description: t('transactionFormPage.createdSuccess') });
      }
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      onClose(true);
    } catch (error) {
      console.error('Failed to save transaction:', error);
      toast({
        title: t('common.error'),
        description: t('transactionFormPage.saveFailed'),
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedAccount = accounts?.find(a => a.id === selectedAccountId);

  // Currency mismatch validation — must be after selectedAccount is defined
  useEffect(() => {
    if (!isInvestment || !selectedAccount || !watchedAssetCurrency) {
      form.clearErrors('ticker');
      return;
    }
    if (watchedAssetCurrency !== selectedAccount.currencyCode) {
      form.setError('ticker', {
        type: 'manual',
        message: t('transactionFormPage.currencyMismatch', { currency: watchedAssetCurrency }) + ' ' + t('transactionFormPage.currencyMismatchAlt', { currency: watchedAssetCurrency, txCurrency: selectedAccount.currencyCode }),
      });
    } else {
      form.clearErrors('ticker');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes reference on every render; translations are stable within a session
  }, [watchedAssetCurrency, selectedAccount, isInvestment, form]);

  if (isLoading) {
    return <div className="p-8 text-center">{t('transactionFormPage.loadingFormData')}</div>;
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="transaction_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('transactionFormPage.dateLabel')}</FormLabel>
              <Popover>
                <PopoverTrigger asChild>
                  <FormControl>
                    <Button
                      type="button"
                      variant={"outline"}
                      className={cn("w-full pl-3 text-left font-normal", !field.value && "text-muted-foreground")}
                    >
                      {field.value ? format(field.value, "PPP") : <span>{t('transactionFormPage.pickDate')}</span>}
                      <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" captionLayout="dropdown-buttons" fromYear={2010} toYear={new Date().getFullYear() + 1} selected={field.value} onSelect={field.onChange} initialFocus />
                </PopoverContent>
              </Popover>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('transactionFormPage.descriptionLabel')}</FormLabel>
              <FormControl>
                <Input placeholder={t('transactionFormPage.descriptionPlaceholder')} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="accountId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('transactionFormPage.accountLabel')}</FormLabel>
              <Select
                onValueChange={(value) => field.onChange(parseInt(value, 10))}
                value={String(field.value ?? '')}
              >
                <FormControl>
                  <SelectTrigger><SelectValue placeholder={t('transactionFormPage.selectAccount')} /></SelectTrigger>
                </FormControl>
                <SelectContent>
                  {sortedAccounts?.map(account => (
                    <SelectItem key={account.id} value={String(account.id)}>{account.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex gap-4">
          <FormField
            control={form.control}
            name="credit"
            render={({ field }) => (
              <FormItem className="w-1/2">
                <FormLabel>{t('transactionFormPage.creditLabel')}</FormLabel>
                <div className="relative">
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    {...field}
                    value={field.value ?? ''}
                    onChange={e => {
                      const value = e.target.value;
                      field.onChange(value === '' ? undefined : parseFloat(value));
                      if (value) {
                        form.setValue('debit', undefined);
                      }
                    }}
                  />
                  {selectedAccount && <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-muted-foreground">{selectedAccount.currencyCode}</div>}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="debit"
            render={({ field }) => (
              <FormItem className="w-1/2">
                <FormLabel>{t('transactionFormPage.debitLabel')}</FormLabel>
                <div className="relative">
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    {...field}
                    value={field.value ?? ''}
                    onChange={e => {
                      const value = e.target.value;
                      field.onChange(value === '' ? undefined : parseFloat(value));
                      if (value) {
                        form.setValue('credit', undefined);
                      }
                    }}
                  />
                  {selectedAccount && <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-muted-foreground">{selectedAccount.currencyCode}</div>}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="categoryId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('transactionFormPage.categoryLabel')}</FormLabel>
              <FormControl>
                <CategoryCombobox
                  categories={categories || []}
                  value={field.value}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="tags"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('transactionFormPage.tags')}</FormLabel>
              <FormControl>
                <TagInput
                  selectedTagIds={(field.value || []).map(Number)}
                  onChange={(ids) => field.onChange(ids)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Accordion
          type="single"
          collapsible
          className="w-full"
          value={investmentAccordionValue}
          onValueChange={setInvestmentAccordionValue}
        >
          <AccordionItem value="investment-details">
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                {t('transactionFormPage.investmentDetails')}
                {!isInvestment && (
                  <span className="text-xs text-muted-foreground font-normal">{t('transactionFormPage.investmentDetailsHint')}</span>
                )}
              </span>
            </AccordionTrigger>
              <AccordionContent className="space-y-4 pt-4">
                <div className="flex gap-4">
                  <FormField
                    control={form.control}
                    name="ticker"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel>{t('transactionFormPage.tickerLabel')}</FormLabel>
                        <div className="relative" ref={tickerDropdownRef}>
                          <FormControl>
                            <Input
                              placeholder={t('transactionFormPage.tickerPlaceholder')}
                              value={tickerSearchInput}
                              autoComplete="off"
                              onChange={e => {
                                const upper = e.target.value.toUpperCase();
                                setTickerSearchInput(upper);
                                field.onChange(upper || undefined);
                                setShowTickerDropdown(upper.length >= 2);
                                // Clear ticker metadata when user edits the ticker text
                                if (!upper) {
                                  form.setValue('assetCurrency', undefined);
                                  form.setValue('exchange', undefined);
                                  form.setValue('isin', undefined);
                                }
                              }}
                              onFocus={() => tickerSearchInput.length >= 2 && setShowTickerDropdown(true)}
                            />
                          </FormControl>
                          {showTickerDropdown && tickerResults.length > 0 && (
                            <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
                              {tickerResults.map((r) => (
                                <button
                                  key={`${r.symbol}-${r.mic_code}`}
                                  type="button"
                                  className="w-full px-3 py-2 text-left hover:bg-accent text-sm flex justify-between items-center"
                                  onClick={() => handleTickerSelect(r)}
                                >
                                  <span className="font-medium">{r.symbol}</span>
                                  <span className="text-xs text-muted-foreground truncate ml-2">
                                    {r.name} ({r.exchange}, {r.currency})
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="flex gap-4">
                  <FormField
                    control={form.control}
                    name="assetPrice"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel>{t('transactionFormPage.pricePerShare')}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            step="any"
                            placeholder="e.g., 125.50"
                            value={field.value ?? ''}
                            onChange={(e) => field.onChange(e.target.value === '' ? undefined : e.target.value)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="assetQuantity"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel>{t('transactionFormPage.quantity')}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            step="any"
                            placeholder={t('transactionFormPage.quantityCalculated')}
                            value={field.value ?? ''}
                            readOnly={!!assetPriceValue}
                            onChange={(e) => field.onChange(e.target.value === '' ? undefined : e.target.value)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

        {isDebt && creditValue && (
          <Accordion type="single" collapsible className="w-full" defaultValue="item-1">
            <AccordionItem value="item-1">
              <AccordionTrigger>{t('transactionFormPage.debtTerms')}</AccordionTrigger>
              <AccordionContent className="space-y-4 pt-4">
                <DebtTermsForm />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}

        <FormField
          control={form.control}
          name="details"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('transactionFormPage.detailsNotes')}</FormLabel>
              <FormControl>
                <Textarea
                  placeholder={t('transactionFormPage.notesPlaceholder')}
                  className="resize-none"
                  {...field}
                  value={field.value ?? ''}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-4">
          <Button type="button" variant="ghost" onClick={() => onClose()}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('transactionFormPage.saving') : transaction ? t('common.save_changes') : t('common.submit')}
          </Button>
        </div>
      </form>
    </Form>
  );
}