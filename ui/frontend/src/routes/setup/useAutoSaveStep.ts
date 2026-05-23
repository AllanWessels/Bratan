import { useEffect, useRef } from "react";
import { useSaveStep } from "@/api/hooks";

/**
 * Debounced auto-save of step data. Skips the first render so we don't post the
 * config's initial values back at the server before the user touches anything.
 */
export function useAutoSaveStep(step: number, data: unknown, delayMs = 500) {
  const save = useSaveStep();
  const isFirstRun = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serialized = JSON.stringify(data);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      save.mutate({ step, data: JSON.parse(serialized) as Record<string, unknown> });
    }, delayMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, step, delayMs]);

  return save;
}
