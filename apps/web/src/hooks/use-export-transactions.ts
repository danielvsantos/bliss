import { useState } from 'react';
import { api } from '@/lib/api';

interface ExportParams {
  startDate?: string;
  endDate?: string;
  accountId?: number;
  categoryId?: number;
  group?: string;
  type?: string;
  source?: string;
  currencyCode?: string;
  tags?: string[];
}

export function useExportTransactions() {
  const [isExporting, setIsExporting] = useState(false);

  const exportTransactions = async (params?: ExportParams) => {
    setIsExporting(true);
    try {
      const blob = await api.exportTransactions(params);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const today = new Date().toISOString().slice(0, 10);
      a.download = `bliss-export-${today}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } finally {
      setIsExporting(false);
    }
  };

  return { exportTransactions, isExporting };
}
