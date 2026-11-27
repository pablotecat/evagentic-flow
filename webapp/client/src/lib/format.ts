import type { ExecutionStatus } from '../api/types';

export const STATUS_LABELS: Record<ExecutionStatus, string> = {
  pending: 'Pendiente',
  running: 'En ejecución',
  succeeded: 'Finalizada',
  failed: 'Fallida',
  interrupted: 'Interrumpida',
};

export const STATUS_ORDER: ExecutionStatus[] = ['running', 'pending', 'succeeded', 'failed', 'interrupted'];

export function relativeTime(createdAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
  if (seconds < 45) return 'hace instantes';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}
