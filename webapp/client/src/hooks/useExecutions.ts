import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Execution } from '../api/types';

export function useExecutions(intervalMs = 1500): Execution[] {
  const [executions, setExecutions] = useState<Execution[]>([]);
  const sequence = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const mine = ++sequence.current;
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const body = await api<{ executions: Execution[] }>('/api/executions');
        if (!cancelled && mine === sequence.current) setExecutions(body.executions);
      } catch {
        return;
      } finally {
        inFlight = false;
      }
    };
    run();
    const timer = setInterval(run, intervalMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [intervalMs]);
  return executions;
}
