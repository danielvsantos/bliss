import { LayoutGrid } from 'lucide-react';

interface ViewToggleProps {
  viewMode: 'flat' | 'grouped';
  onChange: (mode: 'flat' | 'grouped') => void;
}

export function ViewToggle({ viewMode, onChange }: ViewToggleProps) {
  const isGrouped = viewMode === 'grouped';

  return (
    <button
      onClick={() => onChange(isGrouped ? 'flat' : 'grouped')}
      className={`
        inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
        ${isGrouped
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/80'
        }
      `}
    >
      <LayoutGrid className="h-3.5 w-3.5" />
      Grouped
    </button>
  );
}
