import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ExecutionDetail } from '../api/types';

export type DetailState = { detail: ExecutionDetail | null; missing: boolean };

export function useExecutionDetail(id: string | null, intervalMs = 1500): DetailState & { reload: () => Promise<void> } {
  const [state, setState] = useState<DetailState>({ detail: null, missing: false });
  const sequence = useRef(0);
  useEffect(() => {
    setState({ detail: null, missing: false });
  }, [id]);
  const read = useCallback(async () => {
    if (id === null) return;
    const mine = ++sequence.current;
    const apply = (next: DetailState) => {
      if (mine === sequence.current) setState(next);
    };
    try {
      const detail = await api<ExecutionDetail>(`/api/executions/${encodeURIComponent(id)}`);
      if (detail.execution.id === id) apply({ detail, missing: false });
    } catch {
      setState(current => (mine === sequence.current && current.detail === null
        ? { ...current, missing: true }
        : current));
    }
  }, [id]);
  useEffect(() => {
    if (id === null) return;
    void read();
    const timer = setInterval(() => { void read(); }, intervalMs);
    return () => { clearInterval(timer); };
  }, [id, intervalMs, read]);
  return { ...state, reload: read };
}
