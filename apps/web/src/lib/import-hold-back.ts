import type { TFunction } from 'i18next';
import type { CommitResult, HoldBackReason } from '@/types/api';

/**
 * Smart Import hold-back reasons (#142). The backend commitWorker writes the
 * reasons a row was not committed to `StagedImportRow.errorMessage` as
 * `HELD_BACK:<CODE>[,<CODE>…]`. Mirrors parseHoldBack() / HOLD_BACK_REASONS in
 * packages/shared/src/import/index.js (the web bundle doesn't depend on
 * @bliss/shared) — keep the two in sync.
 */

export const HOLD_BACK_PREFIX = 'HELD_BACK:';

/** Canonical order: investment fields first, then account, then the rest. */
export const HOLD_BACK_REASONS: readonly HoldBackReason[] = [
  'MISSING_TICKER',
  'MISSING_QUANTITY',
  'MISSING_PRICE',
  'MISSING_ACCOUNT',
  'DUPLICATE',
  'UPDATE_FAILED',
  'COMMIT_ERROR',
];

/** Reason codes in an errorMessage, or null for staging text / no message. Unknown codes are dropped. */
export function parseHoldBack(errorMessage: string | null | undefined): HoldBackReason[] | null {
  if (typeof errorMessage !== 'string' || !errorMessage.startsWith(HOLD_BACK_PREFIX)) return null;
  const codes = errorMessage
    .slice(HOLD_BACK_PREFIX.length)
    .split(',')
    .filter((c): c is HoldBackReason => (HOLD_BACK_REASONS as readonly string[]).includes(c));
  return codes.length > 0 ? codes : null;
}

const FIELD_KEYS: Partial<Record<HoldBackReason, string>> = {
  MISSING_TICKER: 'review.holdBack.fieldTicker',
  MISSING_QUANTITY: 'review.holdBack.fieldQuantity',
  MISSING_PRICE: 'review.holdBack.fieldPrice',
};

const LABEL_KEYS: Partial<Record<HoldBackReason, string>> = {
  MISSING_ACCOUNT: 'review.holdBack.missingAccount',
  DUPLICATE: 'review.holdBack.duplicate',
  UPDATE_FAILED: 'review.holdBack.updateFailed',
  COMMIT_ERROR: 'review.holdBack.commitError',
};

/**
 * Translated labels for a row's reasons. The investment fields merge into one
 * label ("Missing quantity, price"); every other reason gets its own.
 */
export function holdBackLabels(t: TFunction, codes: readonly HoldBackReason[]): string[] {
  const fields = HOLD_BACK_REASONS.filter((c) => FIELD_KEYS[c] && codes.includes(c)).map((c) => t(FIELD_KEYS[c]!));
  const labels: string[] = [];
  if (fields.length > 0) labels.push(t('review.holdBack.missingFields', { fields: fields.join(', ') }));
  for (const c of HOLD_BACK_REASONS) {
    if (LABEL_KEYS[c] && codes.includes(c)) labels.push(t(LABEL_KEYS[c]!));
  }
  return labels;
}

const COUNT_KEYS: Record<HoldBackReason, string> = {
  MISSING_TICKER: 'review.commitToast.missingTicker',
  MISSING_QUANTITY: 'review.commitToast.missingQuantity',
  MISSING_PRICE: 'review.commitToast.missingPrice',
  MISSING_ACCOUNT: 'review.commitToast.missingAccount',
  DUPLICATE: 'review.commitToast.duplicate',
  UPDATE_FAILED: 'review.commitToast.updateFailed',
  COMMIT_ERROR: 'review.commitToast.commitError',
};

/**
 * Title + description for the toast shown when a commit finishes, e.g.
 * "12 created. 25 held back: 18 missing price, 4 missing account, 3 duplicates. 2 still to review."
 *
 * `remaining` can include rows the user never confirmed; those are reported as
 * "still to review", never attributed to a reason. Payloads written before #142
 * have no `heldBack` and render as before.
 */
export function buildCommitToast(
  t: TFunction,
  result: CommitResult | null | undefined,
  kind: 'committed' | 'partial',
): { title: string; description: string } {
  const title = kind === 'committed' ? t('review.commitToast.committedTitle') : t('review.commitToast.partialTitle');

  const done: string[] = [];
  if (result?.transactionCount) done.push(t('review.commitToast.created', { count: result.transactionCount }));
  if (result?.updateCount) done.push(t('review.commitToast.updated', { count: result.updateCount }));

  const sentences: string[] = [];
  if (done.length > 0) sentences.push(done.join(', '));
  else if (kind === 'partial') sentences.push(t('review.commitToast.noneCommitted'));

  const heldBack = result?.heldBack;
  const heldBackTotal = heldBack?.total ?? 0;
  if (heldBack && heldBackTotal > 0) {
    const reasons = HOLD_BACK_REASONS
      .filter((c) => (heldBack.byReason[c] ?? 0) > 0)
      .map((c) => t(COUNT_KEYS[c], { count: heldBack.byReason[c] }));
    sentences.push(t('review.commitToast.heldBack', { count: heldBackTotal, reasons: reasons.join(', ') }));
  }

  if (kind === 'partial' && result) {
    // Failed update rows go to ERROR, which `remaining` doesn't count. They only
    // ever carry UPDATE_FAILED, so its count is exactly the number of those rows.
    const heldBackRemaining = heldBackTotal - (heldBack?.byReason.UPDATE_FAILED ?? 0);
    const stillToReview = Math.max(0, result.remaining - heldBackRemaining);
    if (stillToReview > 0) sentences.push(t('review.commitToast.stillToReview', { count: stillToReview }));
  }

  if (sentences.length === 0) return { title, description: t('review.commitToast.done') };
  return { title, description: sentences.map((s) => `${s}.`).join(' ') };
}
