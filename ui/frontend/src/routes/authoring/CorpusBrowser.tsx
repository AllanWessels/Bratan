import { useEffect } from "react";
import { Database, FileText, Play } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Spinner } from "@/components/Spinner";
import { useCorpusFiles, useIngestStatus, useStartIngest } from "@/api/hooks";
import { useUIStore } from "@/store/uiStore";
import { formatBytes } from "@/lib/format";

export function CorpusBrowser() {
  const files = useCorpusFiles();
  const startIngest = useStartIngest();
  // Poll faster while running so the UI doesn't look frozen on multi-file
  // ingests where the per-file work dominates.
  const status = useIngestStatus(500);
  const pushToast = useUIStore((s) => s.pushToast);

  const ingestRunning = status.data?.state === "running";

  useEffect(() => {
    if (status.data?.state === "succeeded") {
      pushToast("Corpus ingested", "success");
    } else if (status.data?.state === "failed") {
      pushToast(`Ingest failed: ${status.data.error ?? "unknown"}`, "error");
    }
    // intentionally only respond to state transitions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.state]);

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Database className="h-4 w-4 text-slate-500" /> Corpus
        </span>
      }
    >
      <div className="mb-3 flex flex-col gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => startIngest.mutate()}
          loading={startIngest.isPending || ingestRunning}
          disabled={ingestRunning}
          data-testid="ingest-corpus"
        >
          <Play className="h-3.5 w-3.5" /> Ingest corpus
        </Button>
        <span data-testid="ingest-status" className="sr-only">
          {status.data?.state ?? "idle"}
        </span>
        {ingestRunning && (
          <div className="text-xs text-slate-600" data-testid="ingest-progress">
            <div className="mb-1 flex justify-between">
              <span>
                {status.data?.files_done ?? 0} / {status.data?.files_total ?? 0} files
              </span>
              <span className="font-mono">
                {status.data?.chunks_written ?? 0} chunks
                {status.data?.chunks_per_sec != null && (
                  <span className="ml-2 text-slate-500">
                    ({status.data.chunks_per_sec.toFixed(1)}/s)
                  </span>
                )}
              </span>
            </div>
            {status.data?.current_file && (
              <p
                className="mb-1 truncate text-[11px] text-slate-500"
                title={status.data.current_file}
                data-testid="ingest-current-file"
              >
                Processing {status.data.current_file}
              </p>
            )}
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-brand-600 transition-all duration-300"
                style={{
                  width: `${
                    status.data && status.data.files_total > 0
                      ? Math.max(
                          (status.data.files_done / status.data.files_total) * 100,
                          // Always show *some* progress so a 1-file ingest
                          // doesn't sit at 0%; pulse fills the rest.
                          5,
                        )
                      : 8
                  }%`,
                }}
              />
              {/* Indeterminate shimmer overlay so the bar visibly moves even
                  when files_total is small. */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/40 to-transparent"
              />
            </div>
          </div>
        )}
      </div>

      <div className="max-h-[40vh] overflow-y-auto">
        {files.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size="sm" />
          </div>
        ) : files.isError ? (
          <p className="text-xs text-red-600">Failed to load corpus files.</p>
        ) : !files.data || files.data.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-500">
            No files in corpus. Drop documents into your corpus path.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {files.data.map((f) => (
              <li
                key={f.path}
                className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-slate-50"
              >
                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                <div className="flex-1 overflow-hidden">
                  <div className="truncate font-medium text-slate-800" title={f.path}>
                    {f.path}
                  </div>
                  <div className="flex gap-2 text-[10px] text-slate-500">
                    <span>{formatBytes(f.size_bytes)}</span>
                    {f.ingested && f.n_chunks != null ? (
                      <span className="rounded bg-emerald-100 px-1 text-emerald-700">
                        {f.n_chunks} chunks
                      </span>
                    ) : (
                      <span className="text-amber-600">not ingested</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
