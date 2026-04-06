import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Sparkles } from 'lucide-react';
import type { ReviewItem } from './types';

// Source key mapping for i18n lookup — maps API values to translation keys
const sourceKeyMap: Record<string, string> = {
  USER_OVERRIDE: 'USER_OVERRIDE',
  EXACT_MATCH: 'EXACT_MATCH',
  VECTOR_SEARCH: 'VECTOR_MATCH',
  VECTOR_MATCH: 'VECTOR_MATCH',
  VECTOR_MATCH_GLOBAL: 'VECTOR_MATCH_GLOBAL',
  PLAID_MAPPED: 'PLAID_HINT',
  LLM: 'LLM',
  AI_CLASSIFICATION: 'LLM',
};

interface AIAnalysisPanelProps {
  item: ReviewItem;
}

export function AIAnalysisPanel({ item }: AIAnalysisPanelProps) {
  const { t } = useTranslation();
  const pct = item.confidence != null ? Math.round(item.confidence * 100) : null;
  const sourceLabel = item.classificationSource
    ? t(`review.sourceLabels.${sourceKeyMap[item.classificationSource] ?? 'default'}`)
    : t('review.unknown');

  // Parse Plaid category hint
  let plaidCategoryDisplay: string | null = null;
  if (item.plaidHint) {
    try {
      const parsed = typeof item.plaidHint === 'string' ? JSON.parse(item.plaidHint) : item.plaidHint;
      plaidCategoryDisplay = parsed?.detailed || parsed?.primary || String(item.plaidHint);
    } catch {
      plaidCategoryDisplay = String(item.plaidHint);
    }
  }

  return (
    <Card>
      <CardContent className="pt-4 pb-3 space-y-4">
        {/* Section header */}
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('review.blissAnalysis')}
          </span>
        </div>

        {/* Confidence */}
        {pct != null && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('review.aiConfidence')}</span>
              <span className="font-semibold">{pct}%</span>
            </div>
            <Progress
              value={pct}
              className="h-2"
            />
          </div>
        )}

        {/* Source */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('review.source')}</span>
          <Badge variant="outline" className="text-xs">
            {sourceLabel}
          </Badge>
        </div>

        {/* Plaid Category */}
        {item.source === 'plaid' && plaidCategoryDisplay && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('review.plaidCategory')}</span>
            <span className="text-xs font-mono text-muted-foreground">
              {plaidCategoryDisplay}
            </span>
          </div>
        )}

        {/* Classification Reasoning */}
        {item.classificationReasoning && (
          <>
            <Separator />
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t('review.whyChose')}
              </span>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {item.classificationReasoning}
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
