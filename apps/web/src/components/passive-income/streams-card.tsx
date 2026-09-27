import { useTranslation } from 'react-i18next';
import { Pencil, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useIncomeStreams } from '@/hooks/use-passive-income';
import { translateCategoryName } from '@/lib/category-i18n';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { IncomeStream } from '@/types/passive-income';

interface Props {
  onAdd: () => void;
  onEdit: (stream: IncomeStream) => void;
}

/**
 * Other income streams (R1.8 / R6): Allowance, Government Welfare and custom
 * "Passive Income" categories. Add / edit / delete go through the Income
 * Terms modal in stream mode.
 */
export function IncomeStreamsCard({ onAdd, onEdit }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en-US';
  const { data, isLoading } = useIncomeStreams();
  const streams = data?.streams ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const noCategories = !isLoading && (data?.eligibleCategories?.length ?? 0) === 0;

  return (
    <Card data-testid="streams-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{t('passiveIncome.streams.title')}</CardTitle>
            <CardDescription>{t('passiveIncome.streams.description')}</CardDescription>
          </div>
          <Button size="sm" className="h-8 gap-1.5 text-xs shrink-0" onClick={onAdd} disabled={noCategories}>
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('passiveIncome.streams.add')}</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : streams.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {noCategories ? t('passiveIncome.streams.noCategories') : t('passiveIncome.streams.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {streams.map((s) => {
              const ended = s.endDate != null && s.endDate.slice(0, 10) < today;
              return (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="font-medium text-brand-deep truncate">
                      {s.name}
                      {ended && (
                        <Badge variant="outline" className="ml-2 text-[10px] px-1.5 py-0 bg-muted text-muted-foreground border-gray-200">
                          {t('passiveIncome.status.ENDED')}
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {translateCategoryName(t, { name: s.categoryName ?? '', defaultCategoryCode: s.categoryCode ?? null })}
                      {' · '}
                      {s.amountPerPayment != null ? formatCurrency(s.amountPerPayment, s.currency || 'USD', locale) : '—'}
                      {' / '}
                      {s.frequency ? t(`passiveIncome.frequency.${s.frequency}`) : '—'}
                      {s.endDate ? ` · ${t('passiveIncome.breakdown.endDate')}: ${formatDate(s.endDate, undefined, locale)}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 shrink-0"
                    aria-label={t('common.edit')}
                    onClick={() => onEdit(s)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
