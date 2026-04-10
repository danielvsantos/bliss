import { z } from 'zod';

export const debtTermsSchema = z.object({
  interestRate: z.coerce.number().min(0, 'Interest rate must be positive'),
  termInMonths: z.coerce.number().min(1, 'Term must be at least 1 month').optional(),
  originationDate: z.date(),
  initialBalance: z.coerce.number().min(0, 'Initial balance must be positive'),
});
