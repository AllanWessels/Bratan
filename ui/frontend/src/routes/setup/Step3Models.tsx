import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Card } from "@/components/Card";
import { Field, TextInput } from "@/components/Field";
import { Button } from "@/components/Button";
import {
  ConnectionBadge,
  explainAnthropicError,
  explainVLLMError,
  type ConnectionState,
} from "@/components/ConnectionBadge";
import { useTestAnthropic, useTestVLLM } from "@/api/hooks";
import type { BratanConfig, ModelConfig } from "@/api/types";
import { cn } from "@/lib/cn";
import { useAutoSaveStep } from "./useAutoSaveStep";

interface Props {
  config: BratanConfig | null;
}

const DEFAULTS: ModelConfig = {
  anthropic_api_key: "",
  oracle_model: "claude-sonnet-4-6",
  vllm_base_url: "http://localhost:8001",
  prejudge_model: "Qwen/Qwen2.5-7B-Instruct-AWQ",
  embedding_model: "BAAI/bge-small-en-v1.5",
  reranker_model: "BAAI/bge-reranker-v2-m3",
  use_local_embedding: true,
  use_local_reranker: true,
  use_local_prejudge: true,
};

interface ToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function Toggle({ label, hint, checked, onChange }: ToggleProps) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 hover:bg-slate-50">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-brand-600" : "bg-slate-300",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
          aria-hidden="true"
        />
      </button>
      <div className="flex-1">
        <span className="text-sm font-medium text-slate-800">{label}</span>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
    </label>
  );
}

export function Step3Models({ config }: Props) {
  const [data, setData] = useState<ModelConfig>(config?.models ?? DEFAULTS);
  const [showKey, setShowKey] = useState(false);
  const anthropicTest = useTestAnthropic();
  const vllmTest = useTestVLLM();

  useEffect(() => {
    if (config?.models) setData(config.models);
  }, [config]);

  useAutoSaveStep(3, data);

  const anthropicBadge: ConnectionState = anthropicTest.isPending
    ? "testing"
    : anthropicTest.data
      ? anthropicTest.data.ok
        ? "ok"
        : "fail"
      : "idle";

  // vLLM is optional — connection-refused is a soft warning, not a failure.
  const vllmDiagnosis =
    vllmTest.data && !vllmTest.data.ok ? explainVLLMError(vllmTest.data.error) : null;
  const vllmBadge: ConnectionState = vllmTest.isPending
    ? "testing"
    : vllmTest.data
      ? vllmTest.data.ok
        ? "ok"
        : vllmDiagnosis?.severity === "warn"
          ? "warn"
          : "fail"
      : "idle";

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="Local vs API"
        description="Each component can run locally (GPU) or against an API. Defaults run everything locally except the oracle judge."
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Toggle
            label="Local embedding"
            hint="bge-small-en-v1.5 on your GPU (~130 MB)."
            checked={data.use_local_embedding}
            onChange={(v) => setData({ ...data, use_local_embedding: v })}
          />
          <Toggle
            label="Local reranker"
            hint="bge-reranker-v2-m3."
            checked={data.use_local_reranker}
            onChange={(v) => setData({ ...data, use_local_reranker: v })}
          />
          <Toggle
            label="Local pre-judge"
            hint="Qwen2.5 via vLLM."
            checked={data.use_local_prejudge}
            onChange={(v) => setData({ ...data, use_local_prejudge: v })}
          />
        </div>
      </Card>

      <Card title="Anthropic API" description="Used for the oracle judge. Never downgraded.">
        <div className="grid grid-cols-1 gap-5">
          <Field
            label="API key"
            required
            hint="Stored locally in bratan.config.yaml — keep this file out of version control."
          >
            {(id) => (
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <TextInput
                    id={id}
                    type={showKey ? "text" : "password"}
                    value={data.anthropic_api_key}
                    onChange={(e) =>
                      setData({ ...data, anthropic_api_key: e.target.value })
                    }
                    placeholder="sk-ant-…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:bg-slate-100"
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <Button
                  variant="secondary"
                  onClick={() =>
                    anthropicTest.mutate({
                      api_key: data.anthropic_api_key,
                      model: data.oracle_model,
                    })
                  }
                  loading={anthropicTest.isPending}
                  disabled={!data.anthropic_api_key}
                >
                  Test
                </Button>
              </div>
            )}
          </Field>
          <div className="flex items-start gap-3" data-testid="anthropic-result">
            <ConnectionBadge
              state={anthropicBadge}
              latencyMs={anthropicTest.data?.latency_ms ?? null}
            />
            {anthropicTest.data && !anthropicTest.data.ok && anthropicTest.data.error && (
              <span
                className="text-xs text-red-600"
                data-testid="anthropic-error-message"
              >
                {explainAnthropicError(anthropicTest.data.error)}
              </span>
            )}
          </div>

          <Field label="Oracle model">
            {(id) => (
              <TextInput
                id={id}
                value={data.oracle_model}
                onChange={(e) => setData({ ...data, oracle_model: e.target.value })}
              />
            )}
          </Field>
        </div>
      </Card>

      <Card
        title="Local vLLM endpoint"
        description="Used for the pre-judge model in inner-loop iterations."
      >
        <div className="grid grid-cols-1 gap-5">
          <Field label="Base URL">
            {(id) => (
              <div className="flex gap-2">
                <TextInput
                  id={id}
                  className="flex-1"
                  value={data.vllm_base_url}
                  onChange={(e) => setData({ ...data, vllm_base_url: e.target.value })}
                />
                <Button
                  variant="secondary"
                  onClick={() =>
                    vllmTest.mutate({
                      base_url: data.vllm_base_url,
                      model: data.prejudge_model,
                    })
                  }
                  loading={vllmTest.isPending}
                  disabled={!data.vllm_base_url}
                >
                  Test
                </Button>
              </div>
            )}
          </Field>
          <div className="flex items-start gap-3" data-testid="vllm-result">
            <ConnectionBadge state={vllmBadge} latencyMs={vllmTest.data?.latency_ms ?? null} />
            {vllmDiagnosis && (
              <span
                className={cn(
                  "text-xs",
                  vllmDiagnosis.severity === "warn" ? "text-amber-700" : "text-red-600",
                )}
                data-testid="vllm-error-message"
              >
                {vllmDiagnosis.message}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <Field label="Pre-judge model">
              {(id) => (
                <TextInput
                  id={id}
                  value={data.prejudge_model}
                  onChange={(e) => setData({ ...data, prejudge_model: e.target.value })}
                />
              )}
            </Field>
            <Field label="Embedding model">
              {(id) => (
                <TextInput
                  id={id}
                  value={data.embedding_model}
                  onChange={(e) => setData({ ...data, embedding_model: e.target.value })}
                />
              )}
            </Field>
            <Field label="Reranker model">
              {(id) => (
                <TextInput
                  id={id}
                  value={data.reranker_model}
                  onChange={(e) => setData({ ...data, reranker_model: e.target.value })}
                />
              )}
            </Field>
          </div>
        </div>
      </Card>
    </div>
  );
}
