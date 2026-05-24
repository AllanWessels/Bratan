import { useEffect, useState } from "react";
import { Database, Sparkles } from "lucide-react";
import { Card } from "@/components/Card";
import { Field, TextInput } from "@/components/Field";
import { Button } from "@/components/Button";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { useTestVectorDB } from "@/api/hooks";
import type { BratanConfig, VectorDBAdapter, VectorDBConfig } from "@/api/types";
import { cn } from "@/lib/cn";
import { useAutoSaveStep } from "./useAutoSaveStep";

interface Props {
  config: BratanConfig | null;
}

const DEFAULTS: VectorDBConfig = {
  adapter: "chroma",
  chroma_path: "./.chroma",
  chroma_collection: "corpus",
  qdrant_url: null,
  qdrant_api_key: null,
  pinecone_api_key: null,
  pinecone_index: null,
  weaviate_url: null,
  pgvector_dsn: null,
};

interface AdapterOption {
  id: VectorDBAdapter;
  label: string;
  blurb: string;
  enabled: boolean;
}

const ADAPTERS: AdapterOption[] = [
  {
    id: "chroma",
    label: "ChromaDB",
    blurb: "Local, file-backed. No external service required.",
    enabled: true,
  },
  { id: "qdrant", label: "Qdrant", blurb: "Self-hosted or cloud.", enabled: true },
  { id: "pinecone", label: "Pinecone", blurb: "Managed service.", enabled: false },
  { id: "weaviate", label: "Weaviate", blurb: "Self-hosted or cloud.", enabled: false },
  { id: "pgvector", label: "pgvector", blurb: "Postgres extension.", enabled: false },
];

export function Step2VectorDB({ config }: Props) {
  const [data, setData] = useState<VectorDBConfig>(config?.vector_db ?? DEFAULTS);
  const testMutation = useTestVectorDB();

  useEffect(() => {
    if (config?.vector_db) setData(config.vector_db);
  }, [config]);

  useAutoSaveStep(2, data);

  const onTest = () => {
    testMutation.mutate({ adapter: data.adapter, config: data });
  };

  const badgeState: "idle" | "testing" | "ok" | "fail" = testMutation.isPending
    ? "testing"
    : testMutation.data
      ? testMutation.data.ok
        ? "ok"
        : "fail"
      : "idle";

  return (
    <Card
      title="Vector database"
      description="Pick the store that will hold embedded corpus chunks. Only Chroma is enabled in M1."
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {ADAPTERS.map((opt) => {
          const selected = data.adapter === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={!opt.enabled}
              onClick={() => opt.enabled && setData({ ...data, adapter: opt.id })}
              aria-pressed={selected}
              className={cn(
                "flex items-start gap-3 rounded-2xl border p-4 text-left transition-all",
                opt.enabled
                  ? "hover:border-brand-400 hover:shadow-sm"
                  : "cursor-not-allowed opacity-60",
                selected
                  ? "border-brand-500 bg-brand-50 ring-2 ring-brand-200"
                  : "border-slate-200 bg-white",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                  selected ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600",
                )}
                aria-hidden="true"
              >
                <Database className="h-5 w-5" />
              </span>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">{opt.label}</h3>
                  {!opt.enabled && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                      <Sparkles className="h-3 w-3" />
                      ships in M5
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">{opt.blurb}</p>
              </div>
            </button>
          );
        })}
      </div>

      {data.adapter === "chroma" && (
        <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2">
          <Field label="Chroma path" hint="Local directory for persistent storage.">
            {(id) => (
              <TextInput
                id={id}
                value={data.chroma_path}
                onChange={(e) => setData({ ...data, chroma_path: e.target.value })}
              />
            )}
          </Field>
          <Field label="Collection name">
            {(id) => (
              <TextInput
                id={id}
                value={data.chroma_collection}
                onChange={(e) => setData({ ...data, chroma_collection: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}

      {data.adapter === "qdrant" && (
        <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2">
          <Field label="Qdrant URL" hint="e.g. http://localhost:6333 or a Qdrant Cloud URL.">
            {(id) => (
              <TextInput
                id={id}
                value={data.qdrant_url ?? ""}
                onChange={(e) => setData({ ...data, qdrant_url: e.target.value || null })}
                placeholder="http://localhost:6333"
              />
            )}
          </Field>
          <Field label="API key" hint="Required for Qdrant Cloud; leave empty for local.">
            {(id) => (
              <TextInput
                id={id}
                type="password"
                value={data.qdrant_api_key ?? ""}
                onChange={(e) => setData({ ...data, qdrant_api_key: e.target.value || null })}
              />
            )}
          </Field>
          <Field label="Collection name">
            {(id) => (
              <TextInput
                id={id}
                value={data.chroma_collection}
                onChange={(e) => setData({ ...data, chroma_collection: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <Button variant="secondary" onClick={onTest} loading={testMutation.isPending}>
          Test connection
        </Button>
        <ConnectionBadge state={badgeState} latencyMs={testMutation.data?.latency_ms ?? null} />
        {testMutation.data && !testMutation.data.ok && testMutation.data.error && (
          <span className="text-xs text-red-600">{testMutation.data.error}</span>
        )}
      </div>
    </Card>
  );
}
