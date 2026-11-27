import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Options } from '../api/types';

export type OptionsState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'loaded'; data: Options };

export function useOptions() {
  const [options, setOptions] = useState<OptionsState>({ kind: 'loading' });
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setOptions({ kind: 'loading' });
    try {
      const data = await api<Options>('/api/options');
      if (mine === sequence.current) setOptions({ kind: 'loaded', data });
    } catch {
      if (mine === sequence.current) setOptions({ kind: 'error' });
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { options, reload };
}
