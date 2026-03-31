import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
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

const debtTermsSchema = z.object({
  initialBalance: z.coerce.number().positive({ message: "Initial balance must be a positive number." }),
  interestRate: z.coerce.number().min(0, { message: "Interest rate cannot be negative." }).max(100, { message: "Interest rate seems too high." }),
  termInMonths: z.coerce.number().int().positive({ message: "Term must be a positive number of months." }),
  originationDate: z.date({ required_error: "An origination date is required." }),
});

type DebtTermsFormValues = z.infer<typeof debtTermsSchema>;

interface DebtTermsFormProps {
  asset: PortfolioItem | null;
  onClose: (refetch?: boolean) => void;
}

export function DebtTermsForm({ asset, onClose }: DebtTermsFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const defaultValues = {
    initialBalance: asset?.debtTerms?.initialBalance || undefined,
    interestRate: asset?.debtTerms?.interestRate || undefined,
    termInMonths: asset?.debtTerms?.termInMonths || undefined,
    originationDate: asset?.debtTerms?.originationDate ? new Date(asset.debtTerms.originationDate) : new Date(),
  };

  const { control, handleSubmit, formState: { errors, isSubmitting } } = useForm<DebtTermsFormValues>({
    resolver: zodResolver(debtTermsSchema),
    defaultValues,
  });

  const onSubmit = async (data: DebtTermsFormValues) => {
    if (!asset) return;

    try {
      await api.createOrUpdateDebtTerms(asset.id, {
        ...data,
        originationDate: data.originationDate.toISOString().split('T')[0], // Format as YYYY-MM-DD
      });
      toast({
        title: 'Success!',
        description: `Debt terms for ${asset.symbol} have been saved.`,
      });
      // Invalidate queries to refetch asset data with the new debt terms
      await queryClient.invalidateQueries({ queryKey: [PORTFOLIO_ITEMS_QUERY_KEY] });
      onClose(true);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to save debt terms. Please try again.',
        variant: 'destructive',
      });
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="initialBalance">Initial Balance</Label>
          <Controller
            name="initialBalance"
            control={control}
            render={({ field }) => <Input {...field} type="number" step="0.01" placeholder="e.g., 250000" />}
          />
          {errors.initialBalance && <p className="text-destructive text-sm">{errors.initialBalance.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="interestRate">Interest Rate (%)</Label>
          <Controller
            name="interestRate"
            control={control}
            render={({ field }) => <Input {...field} type="number" step="0.01" placeholder="e.g., 5.25" />}
          />
          {errors.interestRate && <p className="text-destructive text-sm">{errors.interestRate.message}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="termInMonths">Loan Term (in months)</Label>
        <Controller
          name="termInMonths"
          control={control}
          render={({ field }) => <Input {...field} type="number" placeholder="e.g., 360" />}
        />
        {errors.termInMonths && <p className="text-destructive text-sm">{errors.termInMonths.message}</p>}
      </div>
      
      <div className="space-y-2">
        <Label htmlFor="originationDate">Origination Date</Label>
        <Controller
          name="originationDate"
          control={control}
          render={({ field }) => (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant={"outline"}
                  className="w-full justify-start text-left font-normal"
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {field.value ? format(field.value, "PPP") : <span>Pick a date</span>}
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
        {errors.originationDate && <p className="text-destructive text-sm">{errors.originationDate.message}</p>}
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button type="button" variant="ghost" onClick={() => onClose()}>Cancel</Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : 'Save Terms'}
        </Button>
      </div>
    </form>
  );
} 