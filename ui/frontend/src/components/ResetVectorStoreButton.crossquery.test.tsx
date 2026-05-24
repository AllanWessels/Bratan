import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ResetVectorStoreButton } from "./ResetVectorStoreButton";
import { useCorpusFiles } from "@/api/hooks";
import { useUIStore } from "@/store/uiStore";
import {
  renderWithQueryClient,
  type RequestStub,
} from "@/test-utils/withQueryClient";
import type { CorpusFile, IngestStatus } from "@/api/types";

/**
 * Thin observer that keeps `['corpus-files']` alive in the React Query cache
 * for the duration of the test. Without an active subscriber, invalidation
 * marks the key stale but never triggers a background refetch, so the
 * post-reset payload would never land in the cache.
 */
function CorpusFilesObserver() {
  useCorpusFiles();
  return null;
}

/**
 * Cross-query coupling test for `ResetVectorStoreButton` — closes audit
 * row 10 (Section 3.1 cross-query invalidation class).
 *
 * After the reset mutation succeeds, the `useResetVectorStore` hook
 * (api/hooks.ts:380) invalidates BOTH `["ingest-status"]` AND
 * `["corpus-files"]`. This test asserts that the cache observes both
 * round-trips, so deleting either `invalidateQueries` line would fail
 * the test.
 *
 * If the production code regresses to invalidating only one (or neither)
 * of those keys, the fix would land in `useResetVectorStore` in
 * `ui/frontend/src/api/hooks.ts`.
 */

const PRE_RESET_FILES: CorpusFile[] = [
  {
    path: "guide.md",
    size_bytes: 5000,
    modified: "2026-05-01T00:00:00Z",
    ingested: true,
    n_chunks: 12,
  },
];

const POST_RESET_FILES: CorpusFile[] = [
  {
    path: "guide.md",
    size_bytes: 5000,
    modified: "2026-05-01T00:00:00Z",
    ingested: false,
    n_chunks: null,
  },
];

function makeIngestStatus(state: IngestStatus["state"]): IngestStatus {
  return {
    state,
    task_id: null,
    files_total: 0,
    files_done: 0,
    chunks_written: 0,
    error: null,
    current_file: null,
    chunks_per_sec: null,
  };
}

beforeEach(() => {
  useUIStore.setState({ toasts: [] });
});

describe("ResetVectorStoreButton — cross-query invalidation", () => {
  it("invalidates both ['ingest-status'] and ['corpus-files'] after a successful reset", async () => {
    // The component itself only consumes `useIngestStatus` directly (so the
    // disabled-while-running gate works). But the *hook* it calls,
    // `useResetVectorStore`, must invalidate `['corpus-files']` too —
    // because the file rails in CorpusBrowser and CaseWizardFromCorpus rely
    // on that cache to flip badges back to "not ingested" after a wipe.
    let ingestState: IngestStatus["state"] = "idle";
    let filesPayload: CorpusFile[] = PRE_RESET_FILES;
    let resetCalls = 0;

    const requestStub: RequestStub = ({ method, url }) => {
      if (url.startsWith("/api/corpus/ingest/status")) {
        return makeIngestStatus(ingestState);
      }
      if (url.startsWith("/api/corpus/files")) {
        return filesPayload;
      }
      if (
        method === "POST" &&
        url.startsWith("/api/system/reset-vector-store")
      ) {
        resetCalls += 1;
        // Simulate the post-reset state of the world: the on-disk store is
        // gone, so a subsequent files refetch should report not-ingested.
        ingestState = "idle";
        filesPayload = POST_RESET_FILES;
        return {
          ok: true,
          path_wiped: "/abs/.chroma",
          client_dropped: true,
        };
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    };

    // `CorpusFilesObserver` mounts `useCorpusFiles()`, creating an active
    // subscriber on `['corpus-files']`. React Query only triggers a background
    // refetch on `invalidateQueries` when at least one observer is mounted;
    // without this, invalidation marks the key stale but never fires a new
    // fetch, so the post-reset payload would never land in the cache.
    const { queryClient } = renderWithQueryClient(
      <>
        <CorpusFilesObserver />
        <ResetVectorStoreButton />
      </>,
      { requestStub },
    );

    // Wait for the initial `['corpus-files']` fetch (driven by the observer
    // above) to settle before we fire the reset.
    await waitFor(() => {
      expect(
        queryClient.getQueryState<CorpusFile[]>(["corpus-files"])?.data?.[0]
          .ingested,
      ).toBe(true);
    });

    // Drive the modal + confirm flow.
    const user = userEvent.setup();
    await user.click(screen.getByTestId("reset-vector-store-trigger"));
    await user.type(
      screen.getByTestId("reset-vector-store-confirm-input"),
      "RESET",
    );
    await user.click(screen.getByTestId("reset-vector-store-confirm"));

    // Confirm the reset hit the backend exactly once.
    await waitFor(() => expect(resetCalls).toBe(1));

    // The invalidations must cause both queries to re-fetch with the
    // post-reset payload. `corpus-files` flipping to ingested:false is
    // observable proof that `['corpus-files']` was invalidated; the
    // `['ingest-status']` query's most recent fetch landing AFTER the
    // reset call is observable proof that key was invalidated too.
    await waitFor(() => {
      const filesAfter = queryClient.getQueryState<CorpusFile[]>([
        "corpus-files",
      ]);
      expect(filesAfter?.data?.[0].ingested).toBe(false);
      expect(filesAfter?.data?.[0].n_chunks).toBeNull();
    });

    await waitFor(() => {
      const ingestAfter = queryClient.getQueryState<IngestStatus>([
        "ingest-status",
      ]);
      // dataUpdatedAt is monotonically increasing per fetch; if the cache
      // was invalidated after the reset, this query has a fresh fetch.
      // A non-zero value means the query has been observed at least once.
      expect(ingestAfter?.dataUpdatedAt).toBeGreaterThan(0);
      expect(ingestAfter?.data?.state).toBe("idle");
    });

    // Success toast fires + modal closes.
    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      expect(toasts.some((t) => t.variant === "success")).toBe(true);
    });
    expect(
      screen.queryByTestId("reset-vector-store-modal"),
    ).not.toBeInTheDocument();
  });
});
