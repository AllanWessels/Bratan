import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { BackendError, request } from "./client";
import type {
  BratanConfig,
  ConnectionTest,
  CorpusFile,
  CorpusPassagesResponse,
  CorpusSearchRequest,
  CorpusSearchResponse,
  IngestStatus,
  IterationReport,
  LoopStartRequest,
  LoopStartResponse,
  LoopStatus,
  LoopStopResponse,
  LoopStreamEvent,
  Passage,
  ProbeResult,
  ReportSummary,
  SaveStepRequest,
  SaveStepResponse,
  SeedCase,
  SeedDraft,
  SeedListResponse,
  SeedSaveRequest,
  SeedSaveResponse,
  SeedValidateRequest,
  SeedValidateResponse,
  SetupState,
  StopReason,
  SystemResetResponse,
  TestAnthropicRequest,
  TestVectorDBRequest,
  TestVLLMRequest,
  VLLMStartRequest,
  VLLMStatus,
  VLLMStopResponse,
} from "./types";
import type { GeneratedFileSummary } from "./types-generated";

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

/**
 * Paginated walk of a single corpus file as fixed-line-window passages.
 *
 * Backs the SME "browse the corpus" authoring flow — the user picks a
 * passage first and then writes a question that the passage should answer.
 * Pass `path = null` to disable the query entirely (no file selected).
 */
export function useCorpusPassagesPaginated(
  path: string | null,
  offset: number,
  limit: number,
) {
  return useQuery<CorpusPassagesResponse>({
    queryKey: ["corpus-passages", path, offset, limit],
    queryFn: () =>
      request<CorpusPassagesResponse>("/api/corpus/passages", {
        query: { path: path!, offset, limit },
      }),
    enabled: !!path,
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

// ---------- Red-team generated cases (read-only) ----------

export function useGeneratedFiles(
  options?: Omit<UseQueryOptions<GeneratedFileSummary[]>, "queryKey" | "queryFn">,
) {
  return useQuery<GeneratedFileSummary[]>({
    queryKey: ["seed-generated"],
    queryFn: () => request<GeneratedFileSummary[]>("/api/seed/generated"),
    ...options,
  });
}

export function useGeneratedCases(
  timestamp: string | null,
  options?: Omit<UseQueryOptions<SeedCase[]>, "queryKey" | "queryFn">,
) {
  return useQuery<SeedCase[]>({
    queryKey: ["seed-generated", timestamp],
    queryFn: () =>
      request<SeedCase[]>(`/api/seed/generated/${encodeURIComponent(timestamp ?? "")}`),
    enabled: !!timestamp,
    ...options,
  });
}

// ---------- M2 — Reports + loop control ----------

export function useLatestReport(
  options?: Omit<UseQueryOptions<IterationReport | null>, "queryKey" | "queryFn">,
) {
  return useQuery<IterationReport | null>({
    queryKey: ["report-latest"],
    queryFn: async () => {
      try {
        return await request<IterationReport>("/api/reports/latest");
      } catch (err) {
        if (err instanceof BackendError && err.status === 404) return null;
        throw err;
      }
    },
    ...options,
  });
}

export function useReportHistory() {
  return useQuery<ReportSummary[]>({
    queryKey: ["report-history"],
    queryFn: () => request<ReportSummary[]>("/api/reports/history"),
  });
}

export function useReportByTimestamp(
  ts: string | null | undefined,
  options?: Omit<UseQueryOptions<IterationReport>, "queryKey" | "queryFn" | "enabled">,
) {
  return useQuery<IterationReport>({
    queryKey: ["report-by-ts", ts ?? ""],
    queryFn: () => request<IterationReport>(`/api/reports/${encodeURIComponent(ts ?? "")}`),
    enabled: !!ts,
    ...options,
  });
}

export function useLoopStatus(pollMs: number | false = 2000) {
  return useQuery<LoopStatus>({
    queryKey: ["loop-status"],
    queryFn: () => request<LoopStatus>("/api/loop/status"),
    refetchInterval: pollMs === false ? false : pollMs,
  });
}

export function useStartLoop() {
  const qc = useQueryClient();
  return useMutation<LoopStartResponse, Error, LoopStartRequest>({
    mutationFn: (body) =>
      request<LoopStartResponse>("/api/loop/start", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["loop-status"] });
    },
  });
}

export function useStopLoop() {
  const qc = useQueryClient();
  return useMutation<LoopStopResponse, Error, void>({
    mutationFn: () => request<LoopStopResponse>("/api/loop/stop", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loop-status"] }),
  });
}

// ---------- vLLM lifecycle ----------

export function useVLLMStatus(pollMs: number | false = 2000) {
  return useQuery<VLLMStatus>({
    queryKey: ["vllm-status"],
    queryFn: () => request<VLLMStatus>("/api/system/vllm/status"),
    refetchInterval: pollMs === false ? false : pollMs,
  });
}

export function useStartVLLM() {
  const qc = useQueryClient();
  return useMutation<VLLMStatus, Error, VLLMStartRequest>({
    mutationFn: (body) =>
      request<VLLMStatus>("/api/system/vllm/start", { method: "POST", body }),
    onSuccess: (s) => {
      qc.setQueryData(["vllm-status"], s);
    },
  });
}

export function useStopVLLM() {
  const qc = useQueryClient();
  return useMutation<VLLMStopResponse, Error, void>({
    mutationFn: () =>
      request<VLLMStopResponse>("/api/system/vllm/stop", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vllm-status"] }),
  });
}

// ---------- Vector-store reset (destructive) ----------

/**
 * Wipe `.chroma/` + drop in-process chroma client refs.
 *
 * Guarded server-side: the request body must include `{ confirm: true }`.
 * The UI gate (Type RESET to confirm) is in `ResetVectorStoreButton`;
 * this hook just forwards the confirmed call.
 */
export function useResetVectorStore() {
  const qc = useQueryClient();
  return useMutation<SystemResetResponse, Error, void>({
    mutationFn: () =>
      request<SystemResetResponse>("/api/system/reset-vector-store", {
        method: "POST",
        body: { confirm: true },
      }),
    onSuccess: () => {
      // Anything cached that depends on the vector store is now stale.
      qc.invalidateQueries({ queryKey: ["ingest-status"] });
      qc.invalidateQueries({ queryKey: ["corpus-files"] });
    },
  });
}

interface LoopStreamState {
  reports: IterationReport[];
  lastStopReason: StopReason | null;
  connected: boolean;
}

/**
 * WebSocket-backed live stream of iteration events. Keeps a running list of
 * reports (most recent last) and the last stop_reason seen.
 *
 * Note: the WebSocket URL is computed from `window.location` so it works both
 * under the dev proxy (vite -> :8000) and in production builds.
 */
export function useLoopStream(enabled = true): LoopStreamState {
  const [state, setState] = useState<LoopStreamState>({
    reports: [],
    lastStopReason: null,
    connected: false,
  });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/loop/stream`;

    let cancelled = false;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!cancelled) setState((s) => ({ ...s, connected: true }));
    };
    ws.onclose = () => {
      if (!cancelled) setState((s) => ({ ...s, connected: false }));
    };
    ws.onerror = () => {
      if (!cancelled) setState((s) => ({ ...s, connected: false }));
    };
    ws.onmessage = (ev) => {
      if (cancelled) return;
      try {
        const event = JSON.parse(ev.data) as LoopStreamEvent;
        setState((s) => {
          if (event.type === "iteration_complete" && event.report) {
            // Dedup by (iteration, timestamp).
            const seenKey = (r: IterationReport) => `${r.iteration}::${r.timestamp}`;
            const key = seenKey(event.report);
            if (s.reports.some((r) => seenKey(r) === key)) return s;
            return {
              ...s,
              reports: [...s.reports, event.report],
              lastStopReason: event.report.stop_reason ?? s.lastStopReason,
            };
          }
          if (event.type === "loop_stopped") {
            return { ...s, lastStopReason: s.lastStopReason ?? "manual" };
          }
          return s;
        });
      } catch {
        // Ignore malformed payloads.
      }
    };

    return () => {
      cancelled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }, [enabled]);

  return state;
}
