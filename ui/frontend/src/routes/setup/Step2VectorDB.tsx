import { useEffect, useState } from "react";
import { Database, Code2 } from "lucide-react";
import { Card } from "@/components/Card";
import { Field, TextInput } from "@/components/Field";
import { Button } from "@/components/Button";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { ResetVectorStoreButton } from "@/components/ResetVectorStoreButton";
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
  pinecone_cloud: "aws",
  pinecone_region: "us-east-1",
  pinecone_namespace: "",
  weaviate_url: null,
  weaviate_api_key: null,
  weaviate_collection: "Bratan",
  pgvector_dsn: null,
  pgvector_table: "bratan_chunks",
  other_adapter_module: null,
  other_adapter_class: null,
};

interface AdapterOption {
  id: VectorDBAdapter;
  label: string;
  blurb: string;
}

const ADAPTERS: AdapterOption[] = [
  {
    id: "chroma",
    label: "ChromaDB",
    blurb: "Local, file-backed. No external service required.",
  },
  { id: "qdrant", label: "Qdrant", blurb: "Self-hosted or cloud." },
  { id: "pinecone", label: "Pinecone", blurb: "Managed serverless or pod-based." },
  {
    id: "weaviate",
    label: "Weaviate",
    blurb: "Self-hosted or cloud. Native BM25 + vector hybrid.",
  },
  { id: "pgvector", label: "pgvector", blurb: "Postgres with the pgvector extension." },
  {
    id: "other",
    label: "Other / custom",
    blurb: "Plug in your own VectorDBAdapter subclass.",
  },
];

export function Step2VectorDB({ config }: Props) {
  const [data, setData] = useState<VectorDBConfig>(config?.vector_db ?? DEFAULTS);
  const testMutation = useTestVectorDB();

  useEffect(() => {
    if (config?.vector_db) setData({ ...DEFAULTS, ...config.vector_db });
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

  const isOther = data.adapter === "other";

  return (
    <Card
      title="Vector database"
      description="Pick the store that will hold embedded corpus chunks. Five backends are bundled; pick 'Other' to plug in your own VectorDBAdapter subclass."
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {ADAPTERS.map((opt) => {
          const selected = data.adapter === opt.id;
          const Icon = opt.id === "other" ? Code2 : Database;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setData({ ...data, adapter: opt.id })}
              aria-pressed={selected}
              className={cn(
                "flex items-start gap-3 rounded-2xl border p-4 text-left transition-all hover:border-brand-400 hover:shadow-sm",
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
                <Icon className="h-5 w-5" />
              </span>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-slate-900">{opt.label}</h3>
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

      {data.adapter === "pinecone" && (
        <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2">
          <Field label="API key" hint="From the Pinecone console.">
            {(id) => (
              <TextInput
                id={id}
                type="password"
                value={data.pinecone_api_key ?? ""}
                onChange={(e) =>
                  setData({ ...data, pinecone_api_key: e.target.value || null })
                }
              />
            )}
          </Field>
          <Field label="Index name" hint="Auto-created on first ingest if missing.">
            {(id) => (
              <TextInput
                id={id}
                value={data.pinecone_index ?? ""}
                onChange={(e) =>
                  setData({ ...data, pinecone_index: e.target.value || null })
                }
                placeholder="bratan-corpus"
              />
            )}
          </Field>
          <Field label="Cloud" hint="aws | gcp | azure">
            {(id) => (
              <TextInput
                id={id}
                value={data.pinecone_cloud ?? "aws"}
                onChange={(e) => setData({ ...data, pinecone_cloud: e.target.value })}
              />
            )}
          </Field>
          <Field label="Region">
            {(id) => (
              <TextInput
                id={id}
                value={data.pinecone_region ?? "us-east-1"}
                onChange={(e) => setData({ ...data, pinecone_region: e.target.value })}
              />
            )}
          </Field>
          <Field label="Namespace" hint="Optional; leave empty for default.">
            {(id) => (
              <TextInput
                id={id}
                value={data.pinecone_namespace ?? ""}
                onChange={(e) => setData({ ...data, pinecone_namespace: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}

      {data.adapter === "weaviate" && (
        <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2">
          <Field
            label="Weaviate URL"
            hint="http://localhost:8080 or https://<cluster>.weaviate.network"
          >
            {(id) => (
              <TextInput
                id={id}
                value={data.weaviate_url ?? ""}
                onChange={(e) =>
                  setData({ ...data, weaviate_url: e.target.value || null })
                }
                placeholder="http://localhost:8080"
              />
            )}
          </Field>
          <Field label="API key" hint="Required for Weaviate Cloud; leave empty for local.">
            {(id) => (
              <TextInput
                id={id}
                type="password"
                value={data.weaviate_api_key ?? ""}
                onChange={(e) =>
                  setData({ ...data, weaviate_api_key: e.target.value || null })
                }
              />
            )}
          </Field>
          <Field label="Collection name">
            {(id) => (
              <TextInput
                id={id}
                value={data.weaviate_collection ?? "Bratan"}
                onChange={(e) => setData({ ...data, weaviate_collection: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}

      {data.adapter === "pgvector" && (
        <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2">
          <Field
            label="Postgres DSN"
            hint="postgresql://user:pw@host:port/db — must have the pgvector extension."
          >
            {(id) => (
              <TextInput
                id={id}
                type="password"
                value={data.pgvector_dsn ?? ""}
                onChange={(e) =>
                  setData({ ...data, pgvector_dsn: e.target.value || null })
                }
                placeholder="postgresql://bratan:pw@localhost:5432/bratan"
              />
            )}
          </Field>
          <Field label="Table name">
            {(id) => (
              <TextInput
                id={id}
                value={data.pgvector_table ?? "bratan_chunks"}
                onChange={(e) => setData({ ...data, pgvector_table: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}

      {isOther && (
        <div className="mt-6 space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
            <p className="font-medium">Custom adapter</p>
            <p className="mt-1">
              Point Bratan at a Python class that subclasses{" "}
              <code className="rounded bg-amber-100 px-1">VectorDBAdapter</code>. Bratan
              imports the module and instantiates the class with the full vector-DB
              config as keyword arguments. See{" "}
              <a
                href="https://github.com/AllanWessels/Bratan/blob/main/docs/custom-adapter.md"
                className="underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                docs/custom-adapter.md
              </a>{" "}
              for the full contract and a worked example.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <Field
              label="Module path"
              hint="The Python import path, e.g. 'myproject.adapters.milvus'."
            >
              {(id) => (
                <TextInput
                  id={id}
                  value={data.other_adapter_module ?? ""}
                  onChange={(e) =>
                    setData({ ...data, other_adapter_module: e.target.value || null })
                  }
                  placeholder="myproject.adapters.milvus"
                />
              )}
            </Field>
            <Field label="Class name" hint="The VectorDBAdapter subclass to instantiate.">
              {(id) => (
                <TextInput
                  id={id}
                  value={data.other_adapter_class ?? ""}
                  onChange={(e) =>
                    setData({ ...data, other_adapter_class: e.target.value || null })
                  }
                  placeholder="MilvusAdapter"
                />
              )}
            </Field>
          </div>
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

      {/* Destructive recovery action — sits under Test connection because
          that's where the user lands when the store is in a bad state and
          they want to start over from a clean slate. Only meaningful for
          the chroma adapter; the backend refuses for managed stores. */}
      {data.adapter === "chroma" && (
        <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div>
            <p className="text-sm font-medium text-slate-800">Reset vector store</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Wipes the configured <code className="rounded bg-white px-1">.chroma/</code>{" "}
              directory and drops the backend's in-process client. Use this to
              recover from a poisoned store without restarting the server.
            </p>
          </div>
          <ResetVectorStoreButton size="sm" />
        </div>
      )}
    </Card>
  );
}
