import { useState } from "react";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/Card";
import { Spinner } from "@/components/Spinner";
import { useGeneratedCases, useGeneratedFiles } from "@/api/hooks";
import type { GeneratedFileSummary } from "@/api/types-generated";

/**
 * Read-only viewer for `test_cases/generated/<timestamp>.jsonl` batches the
 * red-team agent produces. Append-only by invariant — no edit/delete UI.
 */
export function GeneratedList() {
  const files = useGeneratedFiles();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Bot className="h-4 w-4 text-slate-500" /> Red-team generated
        </span>
      }
    >
      {files.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      ) : files.isError ? (
        <p className="text-xs text-red-600">Failed to load generated batches.</p>
      ) : !files.data || files.data.length === 0 ? (
        <p
          className="py-2 text-xs text-slate-500"
          data-testid="generated-empty"
        >
          No red-team batches yet. They appear here after the loop runs.
        </p>
      ) : (
        <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
          {files.data.map((f) => (
            <GeneratedRow
              key={f.timestamp}
              file={f}
              expanded={expanded === f.timestamp}
              onToggle={() =>
                setExpanded((cur) => (cur === f.timestamp ? null : f.timestamp))
              }
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

interface RowProps {
  file: GeneratedFileSummary;
  expanded: boolean;
  onToggle: () => void;
}

function GeneratedRow({ file, expanded, onToggle }: RowProps) {
  // Only query when the row is open; collapse releases the data via enabled flag.
  const cases = useGeneratedCases(expanded ? file.timestamp : null);

  return (
    <li
      className="rounded-lg border border-slate-100 bg-white"
      data-testid={`generated-row-${file.timestamp}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-slate-50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        )}
        <span className="flex-1 truncate font-mono text-slate-700" title={file.timestamp}>
          {file.timestamp}
        </span>
        <span className="shrink-0 rounded bg-slate-100 px-1.5 text-[10px] text-slate-600">
          {file.n_cases} case{file.n_cases === 1 ? "" : "s"}
        </span>
      </button>
      {expanded && (
        <div
          className="border-t border-slate-100 px-2 py-2"
          data-testid={`generated-cases-${file.timestamp}`}
        >
          {cases.isLoading ? (
            <div className="flex justify-center py-2">
              <Spinner size="sm" />
            </div>
          ) : cases.isError ? (
            <p className="text-[11px] text-red-600">Failed to load cases.</p>
          ) : !cases.data || cases.data.length === 0 ? (
            <p className="text-[11px] text-slate-500">Empty batch.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {cases.data.map((c) => (
                <li
                  key={c.id}
                  className="rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-700"
                >
                  <p className="font-medium text-slate-800">{c.question}</p>
                  <div className="mt-0.5 flex gap-2 text-[10px] text-slate-500">
                    <span className="rounded bg-white px-1 text-slate-700">
                      {c.failure_category}
                    </span>
                    <span>
                      {new Date(c.created_at).toLocaleString()}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
