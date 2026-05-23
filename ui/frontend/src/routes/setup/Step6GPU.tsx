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

const ROUGH_MODEL_VRAM_MB: Record<string, number> = {
  embedding: 1300,
  reranker: 2300,
  prejudge: 20_000,
};

export function Step6GPU({ config }: Props) {
  const probe = useProbe();

  // Probe on first mount
  useEffect(() => {
    probe.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = probe.data;
  const wantedMb = config
    ? (config.models.use_local_embedding ? ROUGH_MODEL_VRAM_MB.embedding : 0) +
      (config.models.use_local_reranker ? ROUGH_MODEL_VRAM_MB.reranker : 0) +
      (config.models.use_local_prejudge ? ROUGH_MODEL_VRAM_MB.prejudge : 0)
    : 0;
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

      {data?.gpu.vram_total_mb != null && !vramOk && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">VRAM may be insufficient.</p>
            <p className="mt-1 text-sm">
              Selected local models need roughly {wantedMb} MB; detected{" "}
              {data.gpu.vram_total_mb} MB total. Consider unchecking some local toggles in
              Step 3 or running embed/rerank on CPU.
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
