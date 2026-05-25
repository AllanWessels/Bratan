import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "./Button";
import { TextInput } from "./Field";
import { useIngestStatus, useResetVectorStore } from "@/api/hooks";
import { useUIStore } from "@/store/uiStore";
import { cn } from "@/lib/cn";

interface Props {
  /**
   * Visual size of the trigger button. Setup wizard uses md to sit next to
   * "Test connection"; the Run dashboard uses sm to fit the controls row.
   */
  size?: "sm" | "md";
  /** Optional override label. Defaults to "Reset vector store". */
  label?: string;
  /** Extra className passed through to the trigger button. */
  className?: string;
}

/**
 * Destructive "wipe `.chroma/`" action with a Type-RESET confirmation gate.
 *
 * Lives in two places — Step 2 of the setup wizard (under Test connection)
 * and the Run dashboard's Run controls — so users can recover from a
 * poisoned vector store without `rm -rf` and without bouncing uvicorn.
 *
 * The button is disabled whenever an ingest is running; nuking the store
 * mid-ingest would land the pipeline in a worse state than where it started.
 */
export function ResetVectorStoreButton({
  size = "md",
  label = "Reset vector store",
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const reset = useResetVectorStore();
  // Poll the ingest status so the button can disable mid-ingest. 1.5s is the
  // same cadence the Authoring page uses for its ingest watcher, so the two
  // views agree on whether a job is in flight.
  const ingest = useIngestStatus(open ? 1500 : 3000);
  const pushToast = useUIStore((s) => s.pushToast);

  const ingestRunning = ingest.data?.state === "running";

  useEffect(() => {
    if (!open) {
      setTyped("");
      reset.reset();
    }
    // We intentionally exclude `reset` from deps — calling `reset.reset` is a
    // cleanup side effect for this modal, not a value that should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const confirmReady = typed.trim().toUpperCase() === "RESET" && !ingestRunning;

  const onConfirm = () => {
    if (!confirmReady) return;
    reset.mutate(undefined, {
      onSuccess: (res) => {
        pushToast(
          res.path_wiped
            ? `Vector store reset · wiped ${res.path_wiped}`
            : "Vector store reset · nothing on disk to wipe",
          "success",
        );
        setOpen(false);
      },
      onError: (err) => {
        pushToast(`Reset failed: ${err.message}`, "error");
      },
    });
  };

  return (
    <>
      <Button
        variant="danger"
        size={size}
        onClick={() => setOpen(true)}
        disabled={ingestRunning}
        title={
          ingestRunning
            ? "Reset is disabled while ingest is running"
            : undefined
        }
        className={className}
        data-testid="reset-vector-store-trigger"
      >
        <Trash2 className="h-4 w-4" />
        {label}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-vector-store-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          data-testid="reset-vector-store-modal"
          onClick={(e) => {
            // Click backdrop to dismiss.
            if (e.target === e.currentTarget && !reset.isPending) setOpen(false);
          }}
        >
          <div
            className={cn(
              "w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl",
            )}
          >
            <h2
              id="reset-vector-store-title"
              className="text-lg font-semibold text-slate-900"
            >
              Reset vector store
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              This wipes all ingested data from the configured{" "}
              <code className="rounded bg-slate-100 px-1">.chroma/</code>{" "}
              directory and drops the backend's in-process client. Your
              corpus, seed test cases, and reports are not touched, but you
              will need to re-ingest before the pipeline can answer queries.
            </p>
            <p className="mt-3 text-sm font-medium text-slate-800">
              Type <span className="font-mono text-red-600">RESET</span> to
              confirm.
            </p>
            <div className="mt-2">
              <TextInput
                aria-label="Type RESET to confirm"
                placeholder="RESET"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
                data-testid="reset-vector-store-confirm-input"
              />
            </div>
            {ingestRunning && (
              <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                An ingest is currently running. Stop it before resetting the
                store to avoid landing in a half-written state.
              </p>
            )}
            {reset.isError && (
              <p className="mt-3 text-sm text-red-600">
                {(reset.error as Error).message}
              </p>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={reset.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={onConfirm}
                disabled={!confirmReady}
                loading={reset.isPending}
                data-testid="reset-vector-store-confirm"
              >
                Wipe vector store
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
