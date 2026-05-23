import { useEffect, useState } from "react";
import { Card } from "@/components/Card";
import { Field, TextInput } from "@/components/Field";
import { cn } from "@/lib/cn";
import type { BratanConfig, StopCriteria } from "@/api/types";
import { useAutoSaveStep } from "./useAutoSaveStep";

interface Props {
  config: BratanConfig | null;
}

const DEFAULTS: StopCriteria = {
  convergence_threshold: 0.02,
  convergence_window: 5,
  max_iterations: 50,
  anchor_regression_threshold: 0.3,
  regression_policy: "warn",
};

export function Step7Stopping({ config }: Props) {
  const [data, setData] = useState<StopCriteria>(config?.stop ?? DEFAULTS);
  useEffect(() => {
    if (config?.stop) setData(config.stop);
  }, [config]);
  useAutoSaveStep(7, data);

  return (
    <Card
      title="Stopping criteria"
      description="The loop halts when any of these fire. Trigger reason is recorded in the final report."
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Field
          label="Convergence threshold"
          hint="Stop when composite delta is smaller than this across the window."
        >
          {(id) => (
            <TextInput
              id={id}
              type="number"
              step="0.01"
              min={0}
              max={1}
              value={data.convergence_threshold}
              onChange={(e) =>
                setData({ ...data, convergence_threshold: Number(e.target.value) || 0 })
              }
            />
          )}
        </Field>
        <Field label="Convergence window (iterations)">
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={1}
              value={data.convergence_window}
              onChange={(e) =>
                setData({ ...data, convergence_window: Number(e.target.value) || 1 })
              }
            />
          )}
        </Field>
        <Field label="Max iterations">
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={1}
              value={data.max_iterations}
              onChange={(e) =>
                setData({ ...data, max_iterations: Number(e.target.value) || 1 })
              }
            />
          )}
        </Field>
        <Field
          label="Anchor regression threshold"
          hint="Stop if any seed case drops by ≥ this much composite score."
        >
          {(id) => (
            <TextInput
              id={id}
              type="number"
              step="0.05"
              min={0}
              max={1}
              value={data.anchor_regression_threshold}
              onChange={(e) =>
                setData({
                  ...data,
                  anchor_regression_threshold: Number(e.target.value) || 0,
                })
              }
            />
          )}
        </Field>
        <Field label="Regression policy" className="md:col-span-2">
          {() => (
            <div className="flex gap-2">
              {(["warn", "block"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setData({ ...data, regression_policy: p })}
                  aria-pressed={data.regression_policy === p}
                  className={cn(
                    "flex-1 rounded-xl border px-4 py-2 text-sm font-medium transition-colors",
                    data.regression_policy === p
                      ? "border-brand-500 bg-brand-50 text-brand-700"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                  )}
                >
                  {p === "warn" ? "Warn (continue)" : "Block (stop loop)"}
                </button>
              ))}
            </div>
          )}
        </Field>
      </div>
    </Card>
  );
}
