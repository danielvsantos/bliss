export const TREND_MOVING_AVERAGE_WINDOW = 3;

export const movingAverageKey = (group: string) => `${group}__avg`;

export function computeTrendMovingAverages(
  trendChartData: Record<string, number | string>[],
  groups: string[],
  window = TREND_MOVING_AVERAGE_WINDOW
): Record<string, number | string>[] {
  return trendChartData.map((row, index) => {
    if (index < window - 1) return row;
    const withAverages = { ...row };
    groups.forEach(group => {
      let sum = 0;
      for (let i = index - window + 1; i <= index; i++) {
        sum += Number(trendChartData[i][group]) || 0;
      }
      withAverages[movingAverageKey(group)] = sum / window;
    });
    return withAverages;
  });
}
