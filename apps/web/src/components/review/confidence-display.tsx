interface ConfidenceDisplayProps {
  confidence: number | null | undefined;
  source?: string | null | undefined;
}

export function ConfidenceDisplay({ confidence }: ConfidenceDisplayProps) {
  if (confidence == null) {
    return <span className="text-muted-foreground text-xs">-</span>;
  }

  const pct = Math.round(confidence * 100);
  const color =
    pct >= 80 ? 'text-positive' : pct >= 50 ? 'text-warning' : 'text-destructive';

  return (
    <span className={`text-xs font-medium ${color}`}>
      {pct}%
    </span>
  );
}
