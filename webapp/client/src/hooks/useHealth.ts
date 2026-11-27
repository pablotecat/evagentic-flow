import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Health } from '../api/types';

export type HealthState = { health: Health | null; connected: boolean };

export function useHealth(intervalMs = 1500): HealthState {
  const [state, setState] = useState<HealthState>({ health: null, connected: true });
  const sequence = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const mine = ++sequence.current;
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const health = await api<Health>('/api/health');
        if (!cancelled && mine === sequence.current) setState({ health, connected: true });
      } catch {
        if (!cancelled && mine === sequence.current) {
          setState(current => ({ ...current, connected: false }));
        }
      } finally {
        inFlight = false;
      }
    };
    run();
    const timer = setInterval(run, intervalMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [intervalMs]);
  return state;
}
