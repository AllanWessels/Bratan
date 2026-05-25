import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";

import { CaseWizardFromCorpus } from "./CaseWizardFromCorpus";
import { useUIStore } from "@/store/uiStore";
import {
  renderWithQueryClient,
  type RequestStub,
} from "@/test-utils/withQueryClient";
import type {
  CorpusFile,
  CorpusPassagesResponse,
  IngestStatus,
} from "@/api/types";

/**
 * Cross-query coupling test for `CaseWizardFromCorpus` — closes audit
 * row 6 (Section 3.1 cross-query invalidation class).
 *
 * Note from the audit (line 298): the `useIngestStatus.state === "succeeded"`
 * → invalidate `['corpus-files']` effect is DUPLICATED in
 * `CaseWizardFromCorpus.tsx:111`. If someone fixes the duplicate in one
 * place and forgets the other, the from-corpus authoring flow silently
 * regresses ("I clicked ingest in the wizard, the toast popped, but my
 * file rail still says not ingested").
 *
 * Same shape as the CorpusBrowser test: stub flips the ingest status from
 * `running` → `succeeded` and we assert the file rail's badge transitions
 * without anyone manually invalidating.
 */

function makeIngestStatus(state: IngestStatus["state"]): IngestStatus {
  return {
    state,
    task_id: state === "idle" ? null : "t-1",
    files_total: 1,
    files_done: state === "succeeded" ? 1 : 0,
    chunks_written: state === "succeeded" ? 99 : 0,
    error: null,
    current_file: null,
    chunks_per_sec: null,
  };
}

const PRE_INGEST: CorpusFile[] = [
  {
    path: "fia-2026-regs.md",
    size_bytes: 1024,
    modified: "2026-05-01T00:00:00Z",
    ingested: false,
    n_chunks: null,
  },
];

const POST_INGEST: CorpusFile[] = [
  {
    path: "fia-2026-regs.md",
    size_bytes: 1024,
    modified: "2026-05-01T00:00:00Z",
    ingested: true,
    n_chunks: 99,
  },
];

const EMPTY_PASSAGES: CorpusPassagesResponse = {
  passages: [],
  total: 0,
  offset: 0,
  limit: 20,
  window_lines: 10,
};

beforeEach(() => {
  useUIStore.setState({ toasts: [] });
});

describe("CaseWizardFromCorpus — cross-query invalidation", () => {
  it("flips file-rail badge from 'not ingested' to 'n chunks' when ingest status transitions to succeeded", async () => {
    // The from-corpus wizard owns its own copy of the
    // `["corpus-files"]` invalidate-on-succeed effect (line 111). This test
    // exists specifically so a drift between this effect and the one in
    // CorpusBrowser fails loudly: if the duplicate gets removed but the
    // CorpusBrowser one stays, this test goes red.
    let ingestState: IngestStatus["state"] = "running";
    let filesPayload: CorpusFile[] = PRE_INGEST;

    const requestStub: RequestStub = ({ url }) => {
      if (url.startsWith("/api/corpus/files")) return filesPayload;
      if (url.startsWith("/api/corpus/ingest/status")) {
        return makeIngestStatus(ingestState);
      }
      if (url.startsWith("/api/corpus/passages")) return EMPTY_PASSAGES;
      throw new Error(`unexpected request: ${url}`);
    };

    const { queryClient } = renderWithQueryClient(<CaseWizardFromCorpus />, {
      requestStub,
    });

    const rail = await screen.findByTestId("from-corpus-file-list");

    await waitFor(() => {
      expect(within(rail).getByText("fia-2026-regs.md")).toBeInTheDocument();
      expect(within(rail).getByText(/not ingested/i)).toBeInTheDocument();
    });

    // Drive the transition through react-query — same mechanism the user
    // would experience: the 500 ms ingest-status poll catches the next
    // payload, the wizard's effect fires, and the file rail re-renders.
    ingestState = "succeeded";
    filesPayload = POST_INGEST;

    await waitFor(
      () => {
        expect(within(rail).getByText(/99 chunks/)).toBeInTheDocument();
        expect(within(rail).queryByText(/not ingested/i)).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    const corpusState = queryClient.getQueryState<CorpusFile[]>([
      "corpus-files",
    ]);
    expect(corpusState?.data?.[0].n_chunks).toBe(99);

    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      expect(toasts.some((t) => t.variant === "success")).toBe(true);
    });
  });
});
