import type { ExecutionStatus } from '../api/types';
import { STATUS_LABELS } from '../lib/format';

const STATUS_CLASSES: Record<ExecutionStatus, string> = {
  pending: 'bg-amber-100 text-amber-900 ring-amber-600/30 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-400/30',
  running: 'bg-sky-100 text-sky-900 ring-sky-600/30 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-400/30',
  succeeded: 'bg-emerald-100 text-emerald-900 ring-emerald-600/30 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-400/30',
  failed: 'bg-red-100 text-red-900 ring-red-600/30 dark:bg-red-950 dark:text-red-200 dark:ring-red-400/30',
  interrupted: 'bg-violet-100 text-violet-900 ring-violet-600/30 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-400/30',
};

export function StatusBadge({ status }: { status: ExecutionStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_CLASSES[status]}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
