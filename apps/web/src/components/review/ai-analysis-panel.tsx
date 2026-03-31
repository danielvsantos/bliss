import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Sparkles } from 'lucide-react';
import type { ReviewItem } from './types';

const sourceLabels: Record<string, string> = {
  USER_OVERRIDE: 'Set by you',
  EXACT_MATCH: 'Matched from history',
  VECTOR_SEARCH: 'Similar to your history',
  VECTOR_MATCH: 'Similar to your history',
  VECTOR_MATCH_GLOBAL: 'Known spending pattern',
  PLAID_MAPPED: 'Suggested by bank',
  LLM: 'AI analysis',
  AI_CLASSIFICATION: 'AI analysis',
};

interface AIAnalysisPanelProps {
  item: ReviewItem;
}

export function AIAnalysisPanel({ item }: AIAnalysisPanelProps) {
  const pct = item.confidence != null ? Math.round(item.confidence * 100) : null;
  const sourceLabel = item.classificationSource
    ? sourceLabels[item.classificationSource] ?? item.classificationSource
    : 'Unknown';

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
            Bliss Analysis
          </span>
        </div>

        {/* Confidence */}
        {pct != null && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">AI Confidence</span>
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
          <span className="text-muted-foreground">Source</span>
          <Badge variant="outline" className="text-xs">
            {sourceLabel}
          </Badge>
        </div>

        {/* Plaid Category */}
        {item.source === 'plaid' && plaidCategoryDisplay && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Plaid Category</span>
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
                Why I chose this
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
