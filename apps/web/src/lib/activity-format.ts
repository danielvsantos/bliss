import type { TFunction } from 'i18next';
import type { ActivityType } from '@/types/activity';

/** Processing status (#100): translated labels and relative times for the chip, banners and Processing tab. */

export function activityTypeLabel(t: TFunction, type: ActivityType | string): string {
  return t(`activity.types.${type}`, { defaultValue: type });
}

export function stageLabel(t: TFunction, stage: string | null | undefined): string | null {
  return stage ? t(`activity.stages.${stage}`, { defaultValue: stage }) : null;
}

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago". */
export function formatAgo(t: TFunction, iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return t('activity.time.justNow');
  if (seconds < 3600) return t('activity.time.minutesAgo', { count: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t('activity.time.hoursAgo', { count: Math.floor(seconds / 3600) });
  return t('activity.time.daysAgo', { count: Math.floor(seconds / 86_400) });
}

/** "42 s" / "7 min" / "2 h". */
export function formatDuration(t: TFunction, ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return t('activity.time.underSecond');
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t('activity.time.seconds', { count: seconds });
  if (seconds < 3600) return t('activity.time.minutes', { count: Math.round(seconds / 60) });
  return t('activity.time.hours', { count: Math.round(seconds / 3600) });
}

/** Elapsed time since `iso`, as a duration ("running for 7 min"). */
export function formatElapsed(t: TFunction, iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  return Number.isNaN(then) ? null : formatDuration(t, now - then);
}
