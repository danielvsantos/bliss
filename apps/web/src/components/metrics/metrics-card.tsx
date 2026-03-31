import React from "react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatCurrency, isPositive } from "@/lib/utils";
import { useTranslation } from 'react-i18next';

interface MetricsCardProps {
  title: string;
  value: number;
  change: number;
  currency?: string;
  icon: React.ReactNode;
}

export function MetricsCard({
  title,
  value,
  change,
  currency = "USD",
  icon,
}: MetricsCardProps) {
  const { t } = useTranslation();
  const isPositiveChange = isPositive(change);

  return (
    <Card className="overflow-hidden shadow-sm hover:shadow-md transition duration-200">
      <CardContent className="p-5">
        <div className="flex items-center">
          <div className="flex-shrink-0 bg-primary-50 dark:bg-primary-900 rounded-md p-3">
            {icon}
          </div>
          <div className="ml-5 w-0 flex-1">
            <dl>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">
                {title}
              </dt>
              <dd className="flex items-baseline">
                <div className="text-2xl font-semibold text-gray-900 dark:text-white">
                  {formatCurrency(value, currency, undefined, { maximumFractionDigits: 0, minimumFractionDigits: 0 })}
                </div>
                {change !== 0 && (
                  <div
                    className={cn(
                      "ml-2 flex items-baseline text-sm font-semibold",
                      isPositiveChange
                        ? "text-success-500"
                        : "text-destructive"
                    )}
                  >
                    {isPositiveChange ? (
                      <ArrowUpIcon className="h-4 w-4 self-center" />
                    ) : (
                      <ArrowDownIcon className="h-4 w-4 self-center" />
                    )}
                    <span className="sr-only">
                      {isPositiveChange ? "Increased" : "Decreased"} by
                    </span>
                    {Math.abs(change).toFixed(1)}%
                  </div>
                )}
              </dd>
            </dl>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
