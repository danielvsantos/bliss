import { useMemo } from 'react';

interface NetWorthSparklineProps {
  dataPoints: number[];
  width?: number;
  height?: number;
  className?: string;
}

export function NetWorthSparkline({
  dataPoints,
  width = 180,
  height = 36,
  className,
}: NetWorthSparklineProps) {
  const { polyline, areaPath } = useMemo(() => {
    if (dataPoints.length < 2) return { polyline: '', areaPath: '' };

    const min = Math.min(...dataPoints);
    const max = Math.max(...dataPoints);
    const range = max - min || 1;

    const scaleX = (i: number) => (i / (dataPoints.length - 1)) * width;
    const scaleY = (v: number) => height - ((v - min) / range) * height;

    const pts = dataPoints.map((v, i) => `${scaleX(i).toFixed(1)},${scaleY(v).toFixed(1)}`).join(' ');
    const area = `M 0,${height} ${pts} ${width},${height} Z`;

    return { polyline: pts, areaPath: area };
  }, [dataPoints, width, height]);

  if (dataPoints.length < 2) return null;

  const isPositive = dataPoints[dataPoints.length - 1] >= dataPoints[0];
  const strokeColor = isPositive ? 'hsl(var(--positive))' : 'hsl(var(--negative))';
  const gradientId = `sparkGrad-${width}-${height}`;

  return (
    <div className={className}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.16" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <polyline
          points={polyline}
          stroke={strokeColor}
          strokeWidth="1.75"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
