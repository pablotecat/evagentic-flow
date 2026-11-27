import { useState } from 'react';
import { api } from '../api/client';
import type { Health } from '../api/types';
import { usePolling } from './usePolling';

export type HealthState = { health: Health | null; connected: boolean };

export function useHealth(intervalMs = 1500): HealthState {
  const [state, setState] = useState<HealthState>({ health: null, connected: true });
  usePolling({
    intervalMs,
    fetcher: () => api<Health>('/api/health'),
    onSuccess: health => setState({ health, connected: true }),
    onError: () => setState(current => ({ ...current, connected: false })),
  });
  return state;
}
