import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ExecutionDetail } from '../api/types';
import { usePolling } from './usePolling';

export type DetailState = { detail: ExecutionDetail | null; missing: boolean };

export function useExecutionDetail(id: string | null, intervalMs = 1500): DetailState & { reload: () => Promise<void> } {
  const [state, setState] = useState<DetailState>({ detail: null, missing: false });
  useEffect(() => {
    setState({ detail: null, missing: false });
  }, [id]);
  const fetcher = useCallback(() => api<ExecutionDetail>(`/api/executions/${encodeURIComponent(id ?? '')}`), [id]);
  const onSuccess = useCallback((detail: ExecutionDetail) => {
    if (detail.execution.id === id) setState({ detail, missing: false });
  }, [id]);
  const onError = useCallback(() => {
    setState(current => (current.detail === null ? { ...current, missing: true } : current));
  }, []);
  const { reload } = usePolling({
    enabled: id !== null,
    intervalMs,
    key: id,
    fetcher,
    onSuccess,
    onError,
  });
  return { ...state, reload };
}
