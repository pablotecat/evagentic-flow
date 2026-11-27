import { useState } from 'react';
import { api } from '../api/client';
import type { Execution } from '../api/types';
import { usePolling } from './usePolling';

export function useExecutions(intervalMs = 1500): Execution[] {
  const [executions, setExecutions] = useState<Execution[]>([]);
  usePolling({
    intervalMs,
    fetcher: () => api<{ executions: Execution[] }>('/api/executions'),
    onSuccess: body => setExecutions(body.executions),
  });
  return executions;
}
