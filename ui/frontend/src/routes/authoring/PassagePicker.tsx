import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Check } from "lucide-react";
import { useCorpusSearch } from "@/api/hooks";
import type { Passage, PassageRef } from "@/api/types";
import { useDebounce } from "@/lib/useDebounce";
import { cn } from "@/lib/cn";
import { Spinner } from "@/components/Spinner";

interface PassagePickerProps {
  query: string;
  selected: PassageRef[];
  onAdd: (p: Passage) => void;
  onRemove: (ref: PassageRef) => void;
}

function sameRef(a: PassageRef, b: PassageRef): boolean {
  return a.path === b.path && a.line_start === b.line_start && a.line_end === b.line_end;
}

export function PassagePicker({ query, selected, onAdd, onRemove }: PassagePickerProps) {
  const debouncedQuery = useDebounce(query, 350);
  const search = useCorpusSearch();
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (debouncedQuery.trim().length >= 3) {
      search.mutate({ query: debouncedQuery, k: 10 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  if (debouncedQuery.trim().length < 3) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
        Type a question above to search the corpus for relevant passages.
      </div>
    );
  }

  if (search.isPending) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        <Spinner size="sm" /> Searching corpus...
      </div>
    );
  }

  if (search.isError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Search failed: {search.error.message}
      </div>
    );
  }

  const passages = search.data?.passages ?? [];

  return (
    <div className="flex flex-col gap-2">
      {search.data && (
        <p className="text-xs text-slate-500">
          {passages.length} passages found in {search.data.latency_ms.toFixed(0)}ms (model:{" "}
          {search.data.embedding_model})
        </p>
      )}
      {passages.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
          No matching passages. Try rephrasing the question.
        </div>
      )}
      <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto" data-testid="passage-results">
        {passages.map((p) => {
          const key = `${p.path}:${p.line_start}-${p.line_end}`;
          const isSelected = selected.some((s) => sameRef(s, p));
          const isExpanded = expanded === key;
          return (
            <li
              key={key}
              data-testid="passage-result"
              className={cn(
                "rounded-xl border bg-white transition-colors",
                isSelected ? "border-emerald-400 bg-emerald-50" : "border-slate-200",
              )}
            >
              <div className="flex items-start gap-2 p-3">
                <button
                  type="button"
                  onClick={() => setExpanded(isExpanded ? null : key)}
                  className="mt-0.5 rounded p-0.5 text-slate-500 hover:bg-slate-100"
                  aria-label={isExpanded ? "Collapse passage" : "Expand passage"}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
                <div className="flex-1 overflow-hidden">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className="truncate text-xs font-mono text-slate-700"
                      title={p.path}
                    >
                      {p.path}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-500">
                      L{p.line_start}–{p.line_end}
                      {p.score != null && (
                        <span className="ml-1.5 font-mono">{p.score.toFixed(3)}</span>
                      )}
                    </span>
                  </div>
                  <p
                    className={cn(
                      "mt-1 text-xs text-slate-600",
                      !isExpanded && "line-clamp-2",
                    )}
                  >
                    {p.content}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => (isSelected ? onRemove(p) : onAdd(p))}
                  className={cn(
                    "shrink-0 rounded-lg p-1.5 text-xs transition-colors",
                    isSelected
                      ? "bg-emerald-600 text-white hover:bg-emerald-700"
                      : "bg-brand-600 text-white hover:bg-brand-700",
                  )}
                  aria-label={isSelected ? "Remove passage from case" : "Add passage to case"}
                  title={isSelected ? "Remove" : "Add to case"}
                >
                  {isSelected ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
