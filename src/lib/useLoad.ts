import { useCallback, useEffect, useRef, useState } from 'react';

export function useLoad<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const runId = useRef(0);
  const inputs = useRef(deps);

  const reload = useCallback(() => {
    setReloadCount((count) => count + 1);
  }, []);

  // Callers explicitly declare the inputs that invalidate their loader.
  useEffect(() => {
    const currentRun = ++runId.current;
    let active = true;

    if (deps.length !== inputs.current.length || deps.some((value, i) => !Object.is(value, inputs.current[i]))) setData(null);
    inputs.current = deps;
    setLoading(true);
    setError(null);

    const isCurrent = () => active && runId.current === currentRun;

    async function load(): Promise<void> {
      try {
        const result = await fn();
        if (isCurrent()) {
          setData(result);
        }
      } catch (cause: unknown) {
        if (isCurrent()) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (isCurrent()) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      active = false;
      ++runId.current;
    };
  }, [...deps, reloadCount]);

  return { data, loading, error, reload };
}
