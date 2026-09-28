import { buildGroupColorMap } from '@/lib/portfolio-utils';
import { ASSET_CLASSES } from '@/types/equity-analysis';

/** Stable asset class → dataviz color, shared by the badges and the asset class donut. */
export const ASSET_CLASS_COLORS = buildGroupColorMap([...ASSET_CLASSES], new Set());
