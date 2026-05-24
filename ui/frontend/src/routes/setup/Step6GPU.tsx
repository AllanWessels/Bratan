import { useEffect } from "react";
import { Cpu, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Spinner } from "@/components/Spinner";
import { useProbe } from "@/api/hooks";
import type { BratanConfig } from "@/api/types";
import { cn } from "@/lib/cn";

interface Props {
  config: BratanConfig | null;
}

/**
 * Rough VRAM cost (MB) for each *checkpoint family*, keyed by substring match
 * on the model id the user selected in Step 3. The table is intentionally
 * approximate — its job is to flag "you picked a 20 GB model on a 16 GB card",
 * not to predict exact bf16 + KV-cache footprint.
 */
const VRAM_TABLE: Array<{ match: RegExp; mb: number }> = [
  // Embedding
  { match: /bge-small/i, mb: 130 },
  { match: /bge-base/i, mb: 440 },
  { match: /bge-large/i, mb: 1300 },
  // Reranker
  { match: /bge-reranker-v2-m3/i, mb: 2300 },
  { match: /bge-reranker/i, mb: 2000 },
  // Pre-judge / generation
  { match: /Qwen2\.5-7B/i, mb: 5_000 },
  { match: /Qwen2\.5-14B/i, mb: 20_000 },
  { match: /Qwen2\.5-32B/i, mb: 40_000 },
  { match: /Llama-3.*8B/i, mb: 6_000 },
];

function estimateMb(modelId: string, fallbackMb: number): number {
  for (const { match, mb } of VRAM_TABLE) {
    if (match.test(modelId)) return mb;
  }
  return fallbackMb;
}

interface BreakdownRow {
  key: "embedding" | "reranker" | "prejudge";
  label: string;
  model: string;
  mb: number;
}

export function Step6GPU({ config }: Props) {
  const probe = useProbe();

  // Probe on first mount
  useEffect(() => {
    probe.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = probe.data;

  // Only count models the user actually toggled ON in Step 3.
  const breakdown: BreakdownRow[] = [];
  if (config?.models.use_local_embedding) {
    breakdown.push({
      key: "embedding",
      label: "Embedding",
      model: config.models.embedding_model,
      mb: estimateMb(config.models.embedding_model, 1300),
    });
  }
  if (config?.models.use_local_reranker) {
    breakdown.push({
      key: "reranker",
      label: "Reranker",
      model: config.models.reranker_model,
      mb: estimateMb(config.models.reranker_model, 2300),
    });
  }
  if (config?.models.use_local_prejudge) {
    breakdown.push({
      key: "prejudge",
      label: "Pre-judge",
      model: config.models.prejudge_model,
      mb: estimateMb(config.models.prejudge_model, 5_000),
    });
  }
  const wantedMb = breakdown.reduce((acc, row) => acc + row.mb, 0);
  const vramOk = data?.gpu.vram_total_mb != null && data.gpu.vram_total_mb >= wantedMb;

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="GPU detection"
        description="We probe nvidia-smi and your vLLM endpoint to verify the local stack is ready."
        footer={
          <Button onClick={() => probe.mutate()} loading={probe.isPending} variant="secondary">
            Detect GPU now
          </Button>
        }
      >
        {probe.isPending && !data ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner size="sm" /> Probing system...
          </div>
        ) : data ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Stat
              label="GPU"
              ok={data.gpu.detected}
              icon={<Cpu className="h-5 w-5" />}
              value={data.gpu.name ?? "Not detected"}
            />
            <Stat
              label="VRAM total"
              ok={data.gpu.vram_total_mb != null}
              icon={<Cpu className="h-5 w-5" />}
              value={data.gpu.vram_total_mb != null ? `${data.gpu.vram_total_mb} MB` : "n/a"}
            />
            <Stat
              label="VRAM free"
              ok={data.gpu.vram_free_mb != null}
              icon={<Cpu className="h-5 w-5" />}
              value={data.gpu.vram_free_mb != null ? `${data.gpu.vram_free_mb} MB` : "n/a"}
            />
            <Stat
              label="vLLM endpoint"
              ok={data.vllm_reachable}
              icon={<Cpu className="h-5 w-5" />}
              value={data.vllm_reachable ? "Reachable" : "Unreachable"}
            />
          </div>
        ) : probe.isError ? (
          <p className="text-sm text-red-600">Probe failed. Try again.</p>
        ) : null}
      </Card>

      {breakdown.length > 0 && (
        <Card
          title="Selected local models"
          description="Rough VRAM cost per model you toggled on in Step 3. Models toggled off don't count."
        >
          <ul
            data-testid="vram-breakdown"
            className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white"
          >
            {breakdown.map((row) => (
              <li
                key={row.key}
                data-testid={`vram-row-${row.key}`}
                className="flex items-center justify-between px-4 py-2 text-sm"
              >
                <div>
                  <p className="font-medium text-slate-800">{row.label}</p>
                  <p className="text-xs text-slate-500">{row.model}</p>
                </div>
                <span className="font-mono text-slate-700" data-testid={`vram-mb-${row.key}`}>
                  {row.mb} MB
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between px-4 py-2 text-sm font-semibold text-slate-900">
              <span>Total</span>
              <span className="font-mono" data-testid="vram-total-mb">
                {wantedMb} MB
              </span>
            </li>
          </ul>
        </Card>
      )}

      {data?.gpu.vram_total_mb != null && wantedMb > 0 && !vramOk && (
        <div
          className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900"
          data-testid="vram-warning"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">VRAM may be insufficient.</p>
            <p className="mt-1 text-sm">
              Selected local models need roughly {wantedMb} MB; detected{" "}
              {data.gpu.vram_total_mb} MB total. Consider unchecking some local toggles in
              Step 3, picking smaller checkpoints, or running embed/rerank on CPU.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

interface StatProps {
  label: string;
  value: string;
  ok: boolean;
  icon: React.ReactNode;
}
function Stat({ label, value, ok, icon }: StatProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <span
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-lg",
          ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500",
        )}
        aria-hidden="true"
      >
        {ok ? <CheckCircle2 className="h-5 w-5" /> : icon}
      </span>
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
        <p className="text-sm font-medium text-slate-800">{value}</p>
      </div>
    </div>
  );
}
