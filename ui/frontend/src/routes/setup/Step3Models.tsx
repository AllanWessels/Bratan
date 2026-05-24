import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Copy, Check, Play, Square, ExternalLink } from "lucide-react";
import { Card } from "@/components/Card";
import { Field, TextInput } from "@/components/Field";
import { Button } from "@/components/Button";
import {
  ConnectionBadge,
  explainAnthropicError,
  explainVLLMError,
  type ConnectionState,
} from "@/components/ConnectionBadge";
import {
  useStartVLLM,
  useStopVLLM,
  useTestAnthropic,
  useTestVLLM,
  useVLLMStatus,
} from "@/api/hooks";
import type { BratanConfig, ModelConfig, VLLMState } from "@/api/types";
import { useUIStore } from "@/store/uiStore";
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
  // Managed-vLLM lifecycle. Only poll while the pre-judge is ON — there's no
  // reason to keep hitting /api/system/vllm/status if the feature is disabled.
  const vllmStatus = useVLLMStatus(data.use_local_prejudge ? 2000 : false);
  const startVLLM = useStartVLLM();
  const stopVLLM = useStopVLLM();
  const pushToast = useUIStore((s) => s.pushToast);
  // Track last-seen managed state so we can fire-once on transitions to "ready".
  const lastSeenStateRef = useRef<VLLMState | null>(null);

  useEffect(() => {
    if (config?.models) setData(config.models);
  }, [config]);

  useAutoSaveStep(3, data);

  // Auto-fire the Test mutation + flash a success toast when the managed
  // vLLM transitions to "ready". One-shot per transition.
  const currentManagedState = vllmStatus.data?.state ?? null;
  useEffect(() => {
    if (currentManagedState === "ready" && lastSeenStateRef.current !== "ready") {
      pushToast("vLLM is up — running the Test now.", "success");
      vllmTest.mutate({
        base_url: data.vllm_base_url,
        model: data.prejudge_model,
      });
    }
    lastSeenStateRef.current = currentManagedState;
    // We intentionally don't depend on `vllmTest` / `data` so we fire exactly
    // once per transition. Reading the latest URL/model from the closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentManagedState]);

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

      {data.use_local_prejudge && (
        <GetVLLMRunningCard
          model={data.prejudge_model}
          baseUrl={data.vllm_base_url}
          state={vllmStatus.data?.state ?? "stopped"}
          managedModel={vllmStatus.data?.model ?? null}
          managedPort={vllmStatus.data?.port ?? null}
          elapsedS={vllmStatus.data?.elapsed_s ?? 0}
          message={vllmStatus.data?.message ?? null}
          starting={startVLLM.isPending}
          onStart={() =>
            startVLLM.mutate({
              model: data.prejudge_model,
              port: parsePortFromUrl(data.vllm_base_url),
            })
          }
          onStop={() => stopVLLM.mutate()}
          startError={startVLLM.error}
        />
      )}

      <Card
        title="Local vLLM endpoint (optional)"
        description={
          <>
            Point Bratan at the vLLM server you started above (or one you
            already had running). Default <code>http://localhost:8001</code>.
            Only used if <strong>"Local pre-judge"</strong> is toggled ON above.
            The pre-judge is a small, local model that grades cases cheaply
            during inner-loop iterations — the oracle (Anthropic Sonnet 4) still
            grades anything that affects the final report. If you leave the
            pre-judge OFF, you can ignore this section entirely; the loop just
            uses the oracle for every grade, costing more but skipping the
            local-model setup.
          </>
        }
      >
        <div className="grid grid-cols-1 gap-5">
          <Field
            label="Base URL"
            hint={
              <>
                URL of a running vLLM (or OpenAI-compatible) server on your machine
                or LAN. Default <code>http://localhost:8001</code> assumes you've
                started one with e.g.{" "}
                <code>vllm serve Qwen/Qwen2.5-7B-Instruct-AWQ --port 8001</code>.
                If you haven't, the Test will return an{" "}
                <span className="font-medium text-amber-700">amber warning</span>{" "}
                — that's expected and safe to ignore as long as Local pre-judge
                stays OFF.
              </>
            }
          >
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
          {!data.use_local_prejudge && (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              You don't need vLLM right now — "Local pre-judge" is OFF, so the
              loop will use the Anthropic oracle for every grade. Leave the URL
              and a failing Test alone; you can enable this later from Settings.
            </p>
          )}

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

function parsePortFromUrl(url: string): number {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
  } catch {
    /* fall through */
  }
  return 8001;
}

interface GetVLLMRunningCardProps {
  model: string;
  baseUrl: string;
  state: VLLMState;
  managedModel: string | null;
  managedPort: number | null;
  elapsedS: number;
  message: string | null;
  starting: boolean;
  onStart: () => void;
  onStop: () => void;
  startError: Error | null;
}

function GetVLLMRunningCard({
  model,
  baseUrl,
  state,
  managedModel,
  managedPort,
  elapsedS,
  message,
  starting,
  onStart,
  onStop,
  startError,
}: GetVLLMRunningCardProps) {
  const command = `vllm serve ${model} --port ${parsePortFromUrl(baseUrl)}`;
  const isRunning = state === "starting" || state === "downloading" || state === "ready";

  // Detect the "not installed" error specifically; backend returns
  // BackendError with detail.error === "vllm_not_installed".
  const notInstalled =
    !!startError &&
    "detail" in startError &&
    typeof (startError as { detail?: unknown }).detail === "object" &&
    (startError as { detail?: { detail?: { error?: string } } }).detail?.detail?.error ===
      "vllm_not_installed";

  return (
    <Card
      title="Get vLLM running"
      description={
        <>
          Start a local vLLM server before pointing Bratan at it below. Pick one
          of the two paths — Bratan can either start it for you, or hand you the
          exact command to run it yourself.
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="get-vllm-running">
        {/* Auto-start panel */}
        <div
          className="flex flex-col gap-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4"
          data-testid="vllm-autostart-panel"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">
              Auto-start (recommended)
            </h3>
            <VLLMStateBadge state={state} />
          </div>
          <p className="text-xs text-slate-600">
            Bratan spawns <code>vllm serve</code> as a managed background
            process. First run downloads ~5 GB of weights — keep this tab open.
          </p>

          <div className="flex items-center gap-2">
            {!isRunning ? (
              <Button
                variant="primary"
                onClick={onStart}
                loading={starting}
                data-testid="vllm-start-button"
              >
                <Play className="h-4 w-4" />
                Start vLLM server
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={onStop}
                data-testid="vllm-stop-button"
              >
                <Square className="h-4 w-4" />
                Stop vLLM
              </Button>
            )}
            {state === "ready" && (
              <span className="text-xs text-emerald-700" data-testid="vllm-ready-hint">
                Ready on {managedModel ?? model}:{managedPort ?? "?"} — the Test
                above just flashed green.
              </span>
            )}
          </div>

          {(state === "starting" || state === "downloading") && (
            <div
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600"
              data-testid="vllm-progress"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-700">
                  {state === "downloading"
                    ? "Downloading model weights…"
                    : "Starting vLLM server…"}
                </span>
                <span className="tabular-nums text-slate-500">
                  {Math.floor(elapsedS)}s
                </span>
              </div>
              {message && <p className="mt-1 text-slate-500">{message}</p>}
            </div>
          )}

          {state === "failed" && (
            <p
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
              data-testid="vllm-failed-message"
            >
              {message ?? "vLLM failed to start. Check the server logs."}
            </p>
          )}

          {notInstalled && (
            <p
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
              data-testid="vllm-not-installed-message"
            >
              vLLM isn't installed in this environment. Run{" "}
              <code className="rounded bg-amber-100 px-1">uv sync --extra gpu</code>{" "}
              in a terminal, then click Start again. Heads-up: this pulls a
              CUDA-enabled torch (~2 GB) and needs a recent NVIDIA driver.
            </p>
          )}
        </div>

        {/* Manual panel */}
        <div
          className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
          data-testid="vllm-manual-panel"
        >
          <h3 className="text-sm font-semibold text-slate-800">
            Show me the command
          </h3>
          <p className="text-xs text-slate-600">
            Prefer to run it yourself in another terminal? Copy this. First run
            downloads ~5 GB of weights and needs GPU memory.
          </p>
          <CopyCommand command={command} />
          <a
            href="https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            vLLM serve docs
          </a>
        </div>
      </div>
    </Card>
  );
}

function VLLMStateBadge({ state }: { state: VLLMState }) {
  const styles: Record<VLLMState, { dot: string; text: string; label: string }> = {
    stopped: { dot: "bg-slate-400", text: "text-slate-600", label: "stopped" },
    starting: { dot: "bg-amber-500 animate-pulse", text: "text-amber-700", label: "starting" },
    downloading: {
      dot: "bg-amber-500 animate-pulse",
      text: "text-amber-700",
      label: "downloading",
    },
    ready: { dot: "bg-emerald-500", text: "text-emerald-700", label: "ready" },
    failed: { dot: "bg-red-500", text: "text-red-700", label: "failed" },
  };
  const s = styles[state];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs font-medium", s.text)}
      data-testid="vllm-state-badge"
      data-state={state}
    >
      <span className={cn("h-2 w-2 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can still select manually. */
    }
  };

  return (
    <div className="flex items-stretch gap-2">
      <code
        className="flex-1 overflow-x-auto rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800"
        data-testid="vllm-manual-command"
      >
        {command}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy command"
        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-100"
        data-testid="vllm-copy-button"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
