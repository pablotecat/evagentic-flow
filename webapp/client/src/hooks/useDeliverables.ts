import { useCallback, useEffect, useState } from 'react';
import { api, isApiFailure } from '../api/client';
import type { DeliverablesBody } from '../api/types';
import { usePolling } from './usePolling';

const reasonFor = (error: unknown): string => (isApiFailure(error) && error.status === 404
  && error.body?.error === 'session-not-in-execution'
  ? 'session-not-in-execution' : 'deliverables-unavailable');

export type DeliverablesState = {
  body: DeliverablesBody | null;
  reload: () => Promise<void>;
};

type ScopedEntry = { key: string; body: DeliverablesBody };

export function useDeliverables(
  executionId: string,
  selectedSession: string | null,
  { enabled = true, intervalMs = 2000 }: { enabled?: boolean; intervalMs?: number } = {},
): DeliverablesState {
  const scopedKey = JSON.stringify([executionId, selectedSession]);
  const [scoped, setScoped] = useState<ScopedEntry | null>(null);
  useEffect(() => {
    setScoped(null);
  }, [scopedKey]);
  const fetcher = useCallback(() => api<DeliverablesBody>(
    `/api/executions/${encodeURIComponent(executionId)}/deliverables`
    + (selectedSession !== null ? `?session=${encodeURIComponent(selectedSession)}` : ''),
  ), [executionId, selectedSession]);
  const onSuccess = useCallback((body: DeliverablesBody) => {
    if (body.executionID !== executionId) return;
    if (selectedSession !== null && body.readable && body.selectedSessionID !== selectedSession) return;
    setScoped({ key: scopedKey, body });
  }, [executionId, scopedKey, selectedSession]);
  const onError = useCallback((error: unknown) => {
    setScoped({ key: scopedKey, body: { executionID: executionId, readable: false, reason: reasonFor(error) } });
  }, [executionId, scopedKey]);
  const { reload } = usePolling({
    enabled,
    intervalMs,
    key: scopedKey,
    fetcher,
    onSuccess,
    onError,
  });
  const body = scoped !== null && scoped.key === scopedKey ? scoped.body : null;
  return { body, reload };
}
