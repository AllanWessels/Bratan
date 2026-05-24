import { useEffect, useState } from "react";
import { AlertOctagon } from "lucide-react";
import { Card } from "@/components/Card";
import { Slider } from "@/components/Slider";
import type { BratanConfig, JudgeWeights } from "@/api/types";
import { useAutoSaveStep } from "./useAutoSaveStep";

interface Props {
  config: BratanConfig | null;
}

const DEFAULTS: JudgeWeights = {
  correctness: 0.4,
  recall_at_5: 0.3,
  faithfulness: 0.3,
};

export function Step8JudgeWeights({ config }: Props) {
  const [data, setData] = useState<JudgeWeights>(config?.judge_weights ?? DEFAULTS);
  useEffect(() => {
    if (config?.judge_weights) setData(config.judge_weights);
  }, [config]);
  useAutoSaveStep(8, data);

  const sum = data.correctness + data.recall_at_5 + data.faithfulness;
  const sumValid = Math.abs(sum - 1.0) < 0.001;

  return (
    <div className="flex flex-col gap-6">
      <div
        role="alert"
        className="flex items-start gap-3 rounded-2xl border-2 border-red-400 bg-red-50 p-4 text-red-900"
      >
        <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="font-semibold">
            Changing these mid-project invalidates comparability with prior reports.
          </p>
          <p className="mt-1 text-sm">
            The composite score is{" "}
            <span className="font-mono">
              correctness·w<sub>c</sub> + recall@5·w<sub>r</sub> + faithfulness·w<sub>f</sub>
            </span>
            . Every report carries a <code>judge_weights_hash</code> so any change is detected.
          </p>
        </div>
      </div>

      <Card title="Composite formula weights" description="Defaults are 0.4 / 0.3 / 0.3.">
        <div className="flex flex-col gap-6">
          <Slider
            label="Correctness"
            min={0}
            max={1}
            step={0.05}
            value={data.correctness}
            onChange={(v) => setData({ ...data, correctness: v })}
            format={(v) => v.toFixed(2)}
          />
          <Slider
            label="Recall @ 5"
            min={0}
            max={1}
            step={0.05}
            value={data.recall_at_5}
            onChange={(v) => setData({ ...data, recall_at_5: v })}
            format={(v) => v.toFixed(2)}
          />
          <Slider
            label="Faithfulness"
            min={0}
            max={1}
            step={0.05}
            value={data.faithfulness}
            onChange={(v) => setData({ ...data, faithfulness: v })}
            format={(v) => v.toFixed(2)}
          />
          <div
            className={
              sumValid
                ? "rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
                : "rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
            }
          >
            Sum: <span className="font-mono">{sum.toFixed(2)}</span>{" "}
            {sumValid ? "(valid)" : "— weights should sum to 1.00"}
          </div>
        </div>
      </Card>
    </div>
  );
}
