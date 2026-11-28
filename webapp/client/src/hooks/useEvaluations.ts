import { useCallback, useEffect, useState } from 'react';
import { api, isApiFailure } from '../api/client';
import type { EvaluationsResponse } from '../api/types';
import { usePolling } from './usePolling';

const reasonFor = (error: unknown): string => (isApiFailure(error) && error.status === 404
  && error.body?.error === 'unknown-execution' ? 'unknown-execution' : 'evaluations-unavailable');

export type EvaluationsState = {
  body: EvaluationsResponse | null;
  reload: () => Promise<void>;
};

type ScopedEntry = { key: string; body: EvaluationsResponse };

export function useEvaluations(
  executionId: string,
  { enabled = true, intervalMs = 2000 }: { enabled?: boolean; intervalMs?: number } = {},
): EvaluationsState {
  const [scoped, setScoped] = useState<ScopedEntry | null>(null);
  useEffect(() => {
    setScoped(null);
  }, [executionId]);
  const fetcher = useCallback(() => api<EvaluationsResponse>(
    `/api/executions/${encodeURIComponent(executionId)}/evaluations`,
  ), [executionId]);
  const onSuccess = useCallback((body: EvaluationsResponse) => {
    if (body.executionID !== executionId) return;
    setScoped({ key: executionId, body });
  }, [executionId]);
  const onError = useCallback((error: unknown) => {
    setScoped({
      key: executionId,
      body: {
        executionID: executionId,
        source: null,
        state: 'read-error',
        reason: reasonFor(error),
        evaluations: null,
      },
    });
  }, [executionId]);
  const { reload } = usePolling({ enabled, intervalMs, key: executionId, fetcher, onSuccess, onError });
  const body = scoped !== null && scoped.key === executionId ? scoped.body : null;
  return { body, reload };
}
