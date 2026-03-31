import { cn } from "@/lib/utils";

interface CategoryLegendItemProps {
  color: string;
  name: string;
  percentage: number;
}

export function CategoryLegendItem({
  color,
  name,
  percentage,
}: CategoryLegendItemProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center">
        <span
          className="h-3 w-3 rounded-full mr-2"
          style={{ backgroundColor: color }}
        />
        <span className="text-sm text-gray-600 dark:text-gray-300 capitalize">
          {name}
        </span>
      </div>
      <span className="text-sm font-medium text-gray-900 dark:text-white">
        {percentage}%
      </span>
    </div>
  );
}
