import type { PlaidTransaction, StagedImportRow } from '@/types/api';

// ─── Unified Review Item ───────────────────────────────────────────────
// Normalizes both PlaidTransaction and StagedImportRow into a single shape
// so the grouped view, drawer, and row components work uniformly.

export type TxStatus = 'ai-approved' | 'new-merchant' | 'needs-enrichment' | 'low-confidence' | 'duplicate' | 'potential-duplicate';

export interface ReviewItem {
  id: string;
  source: 'plaid' | 'import';
  date: string;
  merchant: string;        // PlaidTx.merchantName || PlaidTx.name || ImportRow.description
  description: string;     // Full description / name
  amount: number;
  currency: string;
  status: TxStatus;
  category: string;        // Category name
  categoryId: number | null;
  confidence: number | null;
  classificationSource: string | null;
  classificationReasoning: string | null;
  plaidHint: string | null;              // Plaid category hint
  accountName: string;
  requiresEnrichment: boolean;
  enrichmentType: string | null;
  promotionStatus: string;               // Original promotion/confirm status
  updateTargetId?: number | null;        // Non-null = update row (targets existing Transaction.id)
  updateDiff?: Record<string, { old: unknown; new: unknown; oldName?: string; newName?: string }> | null;
  // References to original objects for mutations
  originalPlaidTx?: PlaidTransaction;
  originalImportRow?: StagedImportRow;
}
