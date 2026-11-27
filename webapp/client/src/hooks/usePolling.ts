import { useEffect, useRef } from 'react';

type PollingOptions<T> = {
  enabled?: boolean;
  intervalMs: number;
  key?: string | number | null;
  fetcher: () => Promise<T>;
  onSuccess: (value: T) => void;
  onError?: (error: unknown) => void;
};

export function usePolling<T>({ enabled = true, intervalMs, key, fetcher, onSuccess, onError }: PollingOptions<T>) {
  const sequence = useRef(0);
  const callbacks = useRef({ fetcher, onSuccess, onError });
  callbacks.current = { fetcher, onSuccess, onError };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const mine = ++sequence.current;
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const value = await callbacks.current.fetcher();
        if (!cancelled && mine === sequence.current) callbacks.current.onSuccess(value);
      } catch (error) {
        if (!cancelled && mine === sequence.current) callbacks.current.onError?.(error);
      } finally {
        inFlight = false;
      }
    };
    void run();
    const timer = setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, intervalMs, key]);
}
