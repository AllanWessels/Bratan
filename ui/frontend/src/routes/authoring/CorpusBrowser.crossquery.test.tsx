import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";

import { CorpusBrowser } from "./CorpusBrowser";
import { useUIStore } from "@/store/uiStore";
import {
  renderWithQueryClient,
  type RequestStub,
} from "@/test-utils/withQueryClient";
import type { CorpusFile, IngestStatus } from "@/api/types";

/**
 * Cross-query coupling test for `CorpusBrowser` — closes audit row 1
 * (Section 3.1 cross-query invalidation class).
 *
 * The existing actuation suite mocks `useCorpusFiles` and `useIngestStatus`
 * as independent puppets, so the load-bearing
 * `qc.invalidateQueries(["corpus-files"])` that fires on
 * `ingestStatus.data?.state === "succeeded"` (CorpusBrowser.tsx:29) is
 * invisible. This test exercises the *real* QueryClient with a stubbed
 * fetch and flips the stub's `/api/corpus/ingest/status` response from
 * `"running"` to `"succeeded"` between polls; the assertion is that the
 * `not ingested` amber badge flips to `n chunks` without anyone manually
 * refetching `["corpus-files"]`.
 */

function makeIngestStatus(state: IngestStatus["state"]): IngestStatus {
  return {
    state,
    task_id: state === "idle" ? null : "t-1",
    files_total: 1,
    files_done: state === "succeeded" ? 1 : 0,
    chunks_written: state === "succeeded" ? 42 : 0,
    error: null,
    current_file: null,
    chunks_per_sec: null,
  };
}

const PRE_INGEST: CorpusFile[] = [
  {
    path: "guide.md",
    size_bytes: 5000,
    modified: "2026-05-01T00:00:00Z",
    ingested: false,
    n_chunks: null,
  },
];

const POST_INGEST: CorpusFile[] = [
  {
    path: "guide.md",
    size_bytes: 5000,
    modified: "2026-05-01T00:00:00Z",
    ingested: true,
    n_chunks: 42,
  },
];

beforeEach(() => {
  useUIStore.setState({ toasts: [] });
});

describe("CorpusBrowser — cross-query invalidation", () => {
  it("flips 'not ingested' → 'n chunks' when ingest status transitions to succeeded", async () => {
    // Mutable state the stub closes over so we can flip the response between
    // polls. This is what makes the test an *integration* test rather than a
    // hook-puppet test: the component's own useEffect must observe the state
    // change via react-query and invalidate `['corpus-files']` for the badge
    // to flip.
    let ingestState: IngestStatus["state"] = "running";
    let filesPayload: CorpusFile[] = PRE_INGEST;

    const requestStub: RequestStub = ({ url }) => {
      if (url.startsWith("/api/corpus/files")) return filesPayload;
      if (url.startsWith("/api/corpus/ingest/status")) {
        return makeIngestStatus(ingestState);
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const { queryClient } = renderWithQueryClient(<CorpusBrowser />, {
      requestStub,
    });

    // Initial render: file shows the amber "not ingested" badge.
    await waitFor(() => {
      expect(screen.getByText("guide.md")).toBeInTheDocument();
      expect(screen.getByText(/not ingested/i)).toBeInTheDocument();
    });

    // Flip the stub: ingest finished, the file list now reports n_chunks.
    // The component is polling `["ingest-status"]` every 500 ms via
    // useIngestStatus, so the next refetch will see state="succeeded",
    // trigger the effect, and invalidate `["corpus-files"]`.
    ingestState = "succeeded";
    filesPayload = POST_INGEST;

    // Sanity: corpus-files is currently fresh (success state) and the
    // invalidation triggered by the effect is what we're really asserting.
    await waitFor(
      () => {
        // The badge has flipped — meaning ['corpus-files'] re-fetched,
        // meaning the invalidation in the effect ran.
        expect(screen.getByText(/42 chunks/)).toBeInTheDocument();
        expect(screen.queryByText(/not ingested/i)).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Confirm via the QueryClient API that the corpus-files query has been
    // observed at least once with the post-ingest payload. This is the
    // assertion that catches the bug if someone deletes the invalidate call.
    const corpusState = queryClient.getQueryState<CorpusFile[]>([
      "corpus-files",
    ]);
    expect(corpusState?.data?.[0].n_chunks).toBe(42);

    // And the success toast fired as part of the same effect.
    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      expect(toasts.some((t) => t.variant === "success")).toBe(true);
    });
  });
});
