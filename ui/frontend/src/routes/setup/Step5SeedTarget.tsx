import { useEffect, useState } from "react";
import { Card } from "@/components/Card";
import { NumberInput } from "@/components/NumberInput";
import type { BratanConfig, ProjectBasics } from "@/api/types";
import { useAutoSaveStep } from "./useAutoSaveStep";

interface Props {
  config: BratanConfig | null;
}

export function Step5SeedTarget({ config }: Props) {
  const [data, setData] = useState<ProjectBasics>(
    config?.project ?? {
      project_name: "bratan",
      corpus_path: "./corpus",
      seed_target_n: 50,
    },
  );
  useEffect(() => {
    if (config?.project) setData(config.project);
  }, [config]);
  useAutoSaveStep(5, data);

  return (
    <Card
      title="Seed target N"
      description="How many human-authored seed test cases to aim for. Loop will warn (not block) below target."
    >
      <NumberInput
        label="Target number of seed cases"
        min={10}
        max={200}
        step={1}
        unit="cases"
        value={data.seed_target_n}
        onChange={(v) => setData({ ...data, seed_target_n: v })}
        hint="Default is 50. Recommended minimum is 30 to make per-category breakdowns meaningful."
      />
      <p className="mt-4 text-sm text-slate-500">
        You can keep authoring beyond N — the loop will pick up any cases added later.
      </p>
    </Card>
  );
}
