import { CheckCircle2, XCircle, AlertCircle, Sparkles } from "lucide-react";
import { Card } from "@/components/Card";
import { Spinner } from "@/components/Spinner";
import type { SeedValidateResponse } from "@/api/types";
import { cn } from "@/lib/cn";

interface ValidationPanelProps {
  result: SeedValidateResponse | null;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  runPipeline: boolean;
  onToggleRunPipeline: (v: boolean) => void;
}

export function ValidationPanel({
  result,
  isLoading,
  isError,
  errorMessage,
  runPipeline,
  onToggleRunPipeline,
}: ValidationPanelProps) {
  return (
    <Card
      title="Validation"
      description="Both checks must pass before you can save the case."
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner size="sm" /> Validating...
        </div>
      ) : isError ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <p>{errorMessage ?? "Validation failed."}</p>
        </div>
      ) : !result ? (
        <p className="text-sm text-slate-500">
          Add a question, passages, and ground-truth answer to run validation.
        </p>
      ) : (
        <div className="flex flex-col gap-3" data-testid="validation-result" data-valid={result.passages_in_top_k && result.answer_text_in_passages ? "true" : "false"}>
          <ValidationRow
            ok={result.passages_in_top_k}
            label="Passages retrievable in top-5"
            detail={`${result.top_k_match_count} of ${result.top_k_searched} selected passages found`}
          />
          <ValidationRow
            ok={result.answer_text_in_passages}
            label="Answer text appears in selected passages"
            detail={
              result.answer_text_in_passages
                ? "Substring match confirmed"
                : "Answer text not found verbatim in any selected passage"
            }
          />

          {result.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-amber-800">
                <AlertCircle className="h-3.5 w-3.5" /> Warnings
              </div>
              <ul className="ml-5 list-disc text-xs text-amber-800">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {result.pipeline_score != null && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-slate-700">
                <Sparkles className="h-3.5 w-3.5" /> Pipeline run
              </div>
              <p className="text-xs text-slate-600">
                Score: <span className="font-mono">{result.pipeline_score.toFixed(2)}</span>
              </p>
              {result.pipeline_answer && (
                <p className="mt-1 line-clamp-3 text-xs text-slate-500">
                  {result.pipeline_answer}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          checked={runPipeline}
          onChange={(e) => onToggleRunPipeline(e.target.checked)}
        />
        <span>
          <span className="font-medium">Also run through pipeline.</span>{" "}
          <span className="text-slate-500">
            Slower; uses configured embedding + retrieval to score this case end-to-end.
          </span>
        </span>
      </label>
    </Card>
  );
}

interface RowProps {
  ok: boolean;
  label: string;
  detail: string;
}

function ValidationRow({ ok, label, detail }: RowProps) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <span
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          ok ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700",
        )}
      >
        {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      </span>
      <div>
        <p className={cn("text-sm font-medium", ok ? "text-emerald-900" : "text-red-900")}>
          {label}
        </p>
        <p className="text-xs text-slate-500">{detail}</p>
      </div>
    </div>
  );
}
