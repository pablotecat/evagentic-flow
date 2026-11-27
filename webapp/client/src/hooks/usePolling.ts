import { useCallback, useEffect, useRef } from 'react';

type PollingOptions<T> = {
  enabled?: boolean;
  intervalMs: number;
  key?: string | number | null;
  fetcher: () => Promise<T>;
  onSuccess: (value: T) => void;
  onError?: (error: unknown) => void;
};

export function usePolling<T>({ enabled = true, intervalMs, key, fetcher, onSuccess, onError }: PollingOptions<T>): { reload: () => Promise<void> } {
  const sequence = useRef(0);
  const callbacks = useRef({ fetcher, onSuccess, onError });
  callbacks.current = { fetcher, onSuccess, onError };
  const triggerRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!enabled) {
      sequence.current += 1;
      triggerRef.current = null;
      return;
    }
    let cancelled = false;
    const mine = ++sequence.current;
    let inFlight: Promise<void> | null = null;
    let queued = false;
    const execute = async () => {
      try {
        const value = await callbacks.current.fetcher();
        if (!cancelled && mine === sequence.current) callbacks.current.onSuccess(value);
      } catch (error) {
        if (!cancelled && mine === sequence.current) callbacks.current.onError?.(error);
      }
    };
    const start = (): Promise<void> => {
      const run = (async () => {
        try {
          await execute();
        } finally {
          inFlight = null;
        }
        if (queued && !cancelled && mine === sequence.current) {
          queued = false;
          await start();
        }
      })();
      inFlight = run;
      return run;
    };
    const tick = () => {
      if (inFlight !== null || cancelled || mine !== sequence.current) return;
      void start();
    };
    const trigger = (): Promise<void> => {
      if (cancelled || mine !== sequence.current) return Promise.resolve();
      if (inFlight !== null) {
        queued = true;
        return inFlight;
      }
      return start();
    };
    triggerRef.current = trigger;
    void start();
    const timer = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      sequence.current += 1;
      clearInterval(timer);
      if (triggerRef.current === trigger) triggerRef.current = null;
    };
  }, [enabled, intervalMs, key]);

  const reload = useCallback(() => triggerRef.current?.() ?? Promise.resolve(), []);
  return { reload };
}
