import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { request } from "./client";
import type {
  BratanConfig,
  ConnectionTest,
  CorpusFile,
  CorpusSearchRequest,
  CorpusSearchResponse,
  IngestStatus,
  Passage,
  ProbeResult,
  SaveStepRequest,
  SaveStepResponse,
  SeedDraft,
  SeedListResponse,
  SeedSaveRequest,
  SeedSaveResponse,
  SeedValidateRequest,
  SeedValidateResponse,
  SetupState,
  TestAnthropicRequest,
  TestVectorDBRequest,
  TestVLLMRequest,
} from "./types";

// ---------- Setup wizard ----------

export function useSetupState(
  options?: Omit<UseQueryOptions<SetupState>, "queryKey" | "queryFn">,
) {
  return useQuery<SetupState>({
    queryKey: ["setup-state"],
    queryFn: () => request<SetupState>("/api/setup/state"),
    ...options,
  });
}

export function useProbe() {
  return useMutation<ProbeResult, Error, void>({
    mutationFn: () => request<ProbeResult>("/api/setup/probe", { method: "POST" }),
  });
}

export function useTestVectorDB() {
  return useMutation<ConnectionTest, Error, TestVectorDBRequest>({
    mutationFn: (body) =>
      request<ConnectionTest>("/api/setup/test-vectordb", { method: "POST", body }),
  });
}

export function useTestAnthropic() {
  return useMutation<ConnectionTest, Error, TestAnthropicRequest>({
    mutationFn: (body) =>
      request<ConnectionTest>("/api/setup/test-anthropic", { method: "POST", body }),
  });
}

export function useTestVLLM() {
  return useMutation<ConnectionTest, Error, TestVLLMRequest>({
    mutationFn: (body) =>
      request<ConnectionTest>("/api/setup/test-vllm", { method: "POST", body }),
  });
}

export function useSaveStep() {
  const qc = useQueryClient();
  return useMutation<SaveStepResponse, Error, SaveStepRequest>({
    mutationFn: (body) =>
      request<SaveStepResponse>("/api/setup/save-step", { method: "POST", body }),
    onSuccess: (resp) => {
      qc.setQueryData(["config"], resp.config);
      qc.invalidateQueries({ queryKey: ["setup-state"] });
    },
  });
}

export function useFinishSetup() {
  const qc = useQueryClient();
  return useMutation<BratanConfig, Error, void>({
    mutationFn: () => request<BratanConfig>("/api/setup/finish", { method: "POST" }),
    onSuccess: (cfg) => {
      qc.setQueryData(["config"], cfg);
      qc.invalidateQueries({ queryKey: ["setup-state"] });
    },
  });
}

export function useConfig(options?: Omit<UseQueryOptions<BratanConfig>, "queryKey" | "queryFn">) {
  return useQuery<BratanConfig>({
    queryKey: ["config"],
    queryFn: () => request<BratanConfig>("/api/config"),
    ...options,
  });
}

export function usePatchConfig() {
  const qc = useQueryClient();
  return useMutation<BratanConfig, Error, Record<string, unknown>>({
    mutationFn: (body) => request<BratanConfig>("/api/config", { method: "PATCH", body }),
    onSuccess: (cfg) => qc.setQueryData(["config"], cfg),
  });
}

// ---------- Corpus ----------

export function useCorpusFiles(enabled = true) {
  return useQuery<CorpusFile[]>({
    queryKey: ["corpus-files"],
    queryFn: () => request<CorpusFile[]>("/api/corpus/files"),
    enabled,
  });
}

export function useCorpusSearch() {
  return useMutation<CorpusSearchResponse, Error, CorpusSearchRequest>({
    mutationFn: (body) =>
      request<CorpusSearchResponse>("/api/corpus/search", { method: "POST", body }),
  });
}

export function useCorpusPassage(
  args: { path: string; start: number; end: number } | null,
) {
  return useQuery<Passage>({
    queryKey: ["corpus-passage", args],
    queryFn: () =>
      request<Passage>("/api/corpus/passage", {
        query: { path: args!.path, start: args!.start, end: args!.end },
      }),
    enabled: !!args,
  });
}

export function useStartIngest() {
  const qc = useQueryClient();
  return useMutation<IngestStatus, Error, void>({
    mutationFn: () => request<IngestStatus>("/api/corpus/ingest", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ingest-status"] }),
  });
}

export function useIngestStatus(pollMs: number | false = false) {
  return useQuery<IngestStatus>({
    queryKey: ["ingest-status"],
    queryFn: () => request<IngestStatus>("/api/corpus/ingest/status"),
    refetchInterval: pollMs === false ? false : pollMs,
  });
}

// ---------- Seed authoring ----------

export function useSeedValidate() {
  return useMutation<SeedValidateResponse, Error, SeedValidateRequest>({
    mutationFn: (body) =>
      request<SeedValidateResponse>("/api/seed/validate", { method: "POST", body }),
  });
}

export function useSeedSave() {
  const qc = useQueryClient();
  return useMutation<SeedSaveResponse, Error, SeedSaveRequest>({
    mutationFn: (body) =>
      request<SeedSaveResponse>("/api/seed/save", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["seed-list"] }),
  });
}

export function useSeedList() {
  return useQuery<SeedListResponse>({
    queryKey: ["seed-list"],
    queryFn: () => request<SeedListResponse>("/api/seed/list"),
  });
}

export function useSeedDrafts() {
  return useQuery<SeedDraft[]>({
    queryKey: ["seed-drafts"],
    queryFn: () => request<SeedDraft[]>("/api/seed/drafts"),
  });
}

export function useSaveDraft() {
  const qc = useQueryClient();
  return useMutation<SeedDraft, Error, { id: string; draft: Partial<SeedDraft> }>({
    mutationFn: ({ id, draft }) =>
      request<SeedDraft>(`/api/seed/drafts/${id}`, { method: "PUT", body: draft }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["seed-drafts"] }),
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (id) =>
      request<{ ok: boolean }>(`/api/seed/drafts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["seed-drafts"] }),
  });
}
