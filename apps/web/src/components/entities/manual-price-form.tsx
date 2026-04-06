import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarIcon } from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import type { PortfolioItem } from '@/types/api';
import { useQueryClient } from '@tanstack/react-query';
import { PORTFOLIO_ITEMS_QUERY_KEY } from '@/hooks/use-portfolio-items';

const priceSchema = z.object({
  date: z.date({ required_error: "A date is required." }),
  value: z.coerce.number().positive({ message: "Price must be a positive number." }),
  currency: z.string().min(3, "Currency code is required.").max(3),
  notes: z.string().optional(),
});

type PriceFormValues = z.infer<typeof priceSchema>;

interface ManualPriceFormProps {
  asset: PortfolioItem | null;
  onClose: (refetch?: boolean) => void;
}

export function ManualPriceForm({ asset, onClose }: ManualPriceFormProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { control, handleSubmit, formState: { errors, isSubmitting }, setValue } = useForm<PriceFormValues>({
    resolver: zodResolver(priceSchema),
    defaultValues: {
      date: new Date(),
      currency: asset?.currency || 'USD',
      value: undefined,
      notes: '',
    },
  });

  const onSubmit = async (data: PriceFormValues) => {
    if (!asset) return;

    try {
      await api.createManualAssetValue(asset.id, {
        date: data.date.toISOString().split('T')[0], // Format as YYYY-MM-DD
        value: data.value,
        currency: data.currency,
        notes: data.notes,
      });
      toast({
        title: t('manualPriceForm.success'),
        description: t('manualPriceForm.savedDetail', { name: asset.symbol }),
      });
      await queryClient.invalidateQueries({ queryKey: [PORTFOLIO_ITEMS_QUERY_KEY] });
      onClose(true);
    } catch (error) {
      toast({
        title: t('common.error'),
        description: t('manualPriceForm.saveFailed'),
        variant: 'destructive',
      });
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="date">{t('manualPriceForm.date')}</Label>
        <Controller
          name="date"
          control={control}
          render={({ field }) => (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant={"outline"}
                  className="w-full justify-start text-left font-normal"
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {field.value ? format(field.value, "PPP") : <span>{t('manualPriceForm.pickDate')}</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar
                  mode="single"
                  captionLayout="dropdown-buttons"
                  fromYear={2010}
                  toYear={new Date().getFullYear() + 1}
                  selected={field.value}
                  onSelect={(date) => date && field.onChange(date)}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          )}
        />
        {errors.date && <p className="text-destructive text-sm">{errors.date.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="value">{t('manualPriceForm.price')}</Label>
        <Controller
          name="value"
          control={control}
          render={({ field }) => <Input {...field} type="number" step="0.01" placeholder={t('manualPriceForm.pricePlaceholder')} />}
        />
        {errors.value && <p className="text-destructive text-sm">{errors.value.message}</p>}
      </div>
      
      <div className="space-y-2">
        <Label htmlFor="currency">{t('manualPriceForm.currency')}</Label>
        <Controller
          name="currency"
          control={control}
          render={({ field }) => <Input {...field} maxLength={3} placeholder={t('manualPriceForm.currencyPlaceholder')} disabled />}
        />
        {errors.currency && <p className="text-destructive text-sm">{errors.currency.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">{t('manualPriceForm.notes')}</Label>
        <Controller
          name="notes"
          control={control}
          render={({ field }) => <Input {...field} placeholder={t('manualPriceForm.notesPlaceholder')} />}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onClose()}>{t('common.cancel')}</Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t('manualPriceForm.saving') : t('manualPriceForm.savePrice')}
        </Button>
      </div>
    </form>
  );
} 