import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ExecutionDetail } from '../api/types';

export type DetailState = { detail: ExecutionDetail | null; missing: boolean };

export function useExecutionDetail(id: string | null, intervalMs = 1500): DetailState {
  const [state, setState] = useState<DetailState>({ detail: null, missing: false });
  const sequence = useRef(0);
  useEffect(() => {
    setState({ detail: null, missing: false });
    if (id === null) return;
    let cancelled = false;
    const mine = ++sequence.current;
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const detail = await api<ExecutionDetail>(`/api/executions/${encodeURIComponent(id)}`);
        if (!cancelled && mine === sequence.current) setState({ detail, missing: false });
      } catch {
        if (!cancelled && mine === sequence.current) {
          setState(current => (current.detail === null ? { ...current, missing: true } : current));
        }
      } finally {
        inFlight = false;
      }
    };
    run();
    const timer = setInterval(run, intervalMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id, intervalMs]);
  return state;
}
