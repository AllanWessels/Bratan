import { useEffect, useRef } from "react";
import { useSaveStep } from "@/api/hooks";

/**
 * Map step → top-level BratanConfig key the step's data slots into.
 * The backend's deep-merge expects {project: {...}}, NOT {project_name: ..., corpus_path: ...}.
 * Without this wrapping, every wizard input is silently dropped by Pydantic's
 * default extra=ignore. See tests/test_wizard_persistence.test.ts.
 */
const STEP_KEY: Record<number, string | null> = {
  1: "project",        // ProjectBasics
  2: "vector_db",      // VectorDBConfig
  3: "models",         // ModelConfig
  4: "cost",           // CostCeilings
  5: "project",        // ProjectBasics (seed_target_n lives here too)
  6: null,             // GPU detection step — no auto-save
  7: "stop",           // StopCriteria
  8: "judge_weights",  // JudgeWeights
};

/**
 * Debounced auto-save of step data. Skips the first render so we don't post the
 * config's initial values back at the server before the user touches anything.
 *
 * The `data` you pass should be the inner slice for the step (e.g. a ProjectBasics
 * object). This hook wraps it with the correct top-level key before POSTing.
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
    const key = STEP_KEY[step];
    if (key === null) return; // step with no persistence (e.g. step 6 GPU probe)
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const inner = JSON.parse(serialized) as Record<string, unknown>;
      save.mutate({
        step,
        data: key ? { [key]: inner } : inner,
      });
    }, delayMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, step, delayMs]);

  return save;
}
