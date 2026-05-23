import { useEffect, useState } from "react";
import { Card } from "@/components/Card";
import { Field, TextInput } from "@/components/Field";
import type { BratanConfig, CostCeilings } from "@/api/types";
import { useAutoSaveStep } from "./useAutoSaveStep";
import { formatTokens, formatUSD } from "@/lib/format";

interface Props {
  config: BratanConfig | null;
}

const DEFAULTS: CostCeilings = {
  usd_per_run: 5.0,
  tokens_per_iteration: 2_000_000,
  cache_ttl_hours: 168,
  subset_eval_size: 10,
};

export function Step4Costs({ config }: Props) {
  const [data, setData] = useState<CostCeilings>(config?.cost ?? DEFAULTS);
  useEffect(() => {
    if (config?.cost) setData(config.cost);
  }, [config]);
  useAutoSaveStep(4, data);

  return (
    <Card
      title="Cost ceilings"
      description="Hard limits that abort the loop early. Cost controls ship in M3 — these get persisted now."
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Field
          label="USD per run"
          hint={`Aborts when usd_spent ≥ this. Currently ${formatUSD(data.usd_per_run)}.`}
        >
          {(id) => (
            <TextInput
              id={id}
              type="number"
              step="0.5"
              min={0}
              value={data.usd_per_run}
              onChange={(e) =>
                setData({ ...data, usd_per_run: Number(e.target.value) || 0 })
              }
            />
          )}
        </Field>
        <Field
          label="Tokens per iteration"
          hint={`Soft cap on tokens. Currently ${formatTokens(data.tokens_per_iteration)}.`}
        >
          {(id) => (
            <TextInput
              id={id}
              type="number"
              step="100000"
              min={0}
              value={data.tokens_per_iteration}
              onChange={(e) =>
                setData({
                  ...data,
                  tokens_per_iteration: Number(e.target.value) || 0,
                })
              }
            />
          )}
        </Field>
        <Field
          label="Cache TTL (hours)"
          hint="Disk-backed response cache lifetime."
        >
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={0}
              value={data.cache_ttl_hours}
              onChange={(e) =>
                setData({ ...data, cache_ttl_hours: Number(e.target.value) || 0 })
              }
            />
          )}
        </Field>
        <Field
          label="Subset eval size"
          hint="Number of test cases used in blue team's inner iteration."
        >
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={1}
              value={data.subset_eval_size}
              onChange={(e) =>
                setData({ ...data, subset_eval_size: Number(e.target.value) || 1 })
              }
            />
          )}
        </Field>
      </div>
    </Card>
  );
}
