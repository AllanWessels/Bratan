import { useEffect, useRef, useState } from "react";

export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** Returns a stable function that delays calling `cb` by `delayMs` from the last invocation. */
export function useDebouncedCallback<Args extends unknown[]>(
  cb: (...args: Args) => void,
  delayMs: number,
): (...args: Args) => void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  return (...args: Args) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => cbRef.current(...args), delayMs);
  };
}
