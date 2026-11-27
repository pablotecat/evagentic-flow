import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ExecutionDetail } from '../api/types';
import { usePolling } from './usePolling';

export type DetailState = { detail: ExecutionDetail | null; missing: boolean };

export function useExecutionDetail(id: string | null, intervalMs = 1500): DetailState {
  const [state, setState] = useState<DetailState>({ detail: null, missing: false });
  useEffect(() => {
    setState({ detail: null, missing: false });
  }, [id]);
  usePolling({
    enabled: id !== null,
    intervalMs,
    key: id,
    fetcher: () => api<ExecutionDetail>(`/api/executions/${encodeURIComponent(id as string)}`),
    onSuccess: detail => setState({ detail, missing: false }),
    onError: () => setState(current => (current.detail === null ? { ...current, missing: true } : current)),
  });
  return state;
}
