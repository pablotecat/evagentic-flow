import { useCallback, useState } from 'react';
import { api } from '../api/client';
import type { RubricsResponse } from '../api/types';
import { usePolling } from './usePolling';

export type RubricsState = {
  body: RubricsResponse | null;
  reload: () => Promise<void>;
};

export function useRubrics({ intervalMs = 2000 }: { intervalMs?: number } = {}): RubricsState {
  const [body, setBody] = useState<RubricsResponse | null>(null);
  const fetcher = useCallback(() => api<RubricsResponse>('/api/rubrics'), []);
  const onSuccess = useCallback((next: RubricsResponse) => setBody(next), []);
  const onError = useCallback(() => setBody({
    source: null,
    state: 'read-error',
    reason: 'rubrics-unavailable',
    rubrics: null,
  }), []);
  const { reload } = usePolling({ intervalMs, fetcher, onSuccess, onError });
  return { body, reload };
}
