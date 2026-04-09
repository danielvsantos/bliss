import { useFormContext } from 'react-hook-form';
import { FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { CalendarIcon } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

export function DebtTermsForm() {
  const form = useFormContext();

  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="debtTerms.initialBalance"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Initial Balance</FormLabel>
            <FormControl>
              <Input type="number" placeholder="e.g., 250000" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="debtTerms.interestRate"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Interest Rate (APR)</FormLabel>
            <FormControl>
              <Input type="number" step="0.01" placeholder="e.g., 5.25" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="debtTerms.termInMonths"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Loan Term (in months)</FormLabel>
            <FormControl>
              <Input type="number" placeholder="e.g., 360" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="debtTerms.originationDate"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Origination Date</FormLabel>
            <Popover>
              <PopoverTrigger asChild>
                <FormControl>
                  <Button
                    variant={"outline"}
                    className={cn("w-full pl-3 text-left font-normal", !field.value && "text-muted-foreground")}
                  >
                    {field.value ? format(field.value, "PPP") : <span>Pick a date</span>}
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
    </div>
  );
} 