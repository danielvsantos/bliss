import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Clock } from 'lucide-react';
import { useSyncLogs } from '@/hooks/use-sync-logs';

interface SyncLogsTableProps {
  plaidItemId: string | null;
}

function LogStatusPill({ status }: { status: string }) {
  if (status === 'SUCCESS') {
    return (
      <Badge variant="default" className="bg-positive/10 text-positive border-positive/20 hover:bg-positive/10 text-[10px] px-1.5 py-0">
        Success
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
      Failed
    </Badge>
  );
}

function formatLogDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatLogType(type: string): string {
  const map: Record<string, string> = {
    INITIAL_SYNC: 'Initial Sync',
    SYNC_UPDATE: 'Sync Update',
    BALANCE_UPDATE: 'Balance Update',
    ERROR: 'Error',
  };
  return map[type] ?? type;
}

export function SyncLogsTable({ plaidItemId }: SyncLogsTableProps) {
  const { data: logs, isLoading } = useSyncLogs(plaidItemId);

  if (!plaidItemId) return null;

  return (
    <Card>
      <CardContent className="pt-4 pb-2">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent Sync Logs
          </span>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-8 bg-muted rounded animate-pulse" />
            ))}
          </div>
        ) : !logs || logs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-3 text-center">No sync logs yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Date</TableHead>
                <TableHead className="text-xs">Type</TableHead>
                <TableHead className="text-xs">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log: { id: string; createdAt: string; type: string; status: string }) => (
                <TableRow key={log.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatLogDate(log.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs">{formatLogType(log.type)}</TableCell>
                  <TableCell>
                    <LogStatusPill status={log.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
