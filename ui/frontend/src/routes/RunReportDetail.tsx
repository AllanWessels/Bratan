import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useReportByTimestamp } from "@/api/hooks";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Spinner } from "@/components/Spinner";
import { formatPercent, formatUSD } from "@/lib/format";

export function RunReportDetail() {
  const { timestamp } = useParams<{ timestamp: string }>();
  const navigate = useNavigate();
  const decoded = timestamp ? decodeURIComponent(timestamp) : null;
  const { data, isLoading, isError, error } = useReportByTimestamp(decoded);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4">
          <Link to="/" className="block">
            <h1 className="text-lg font-semibold text-slate-900">Bratan</h1>
            <p className="text-xs text-slate-500">Report detail</p>
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate("/run")}
              data-testid="back-to-run"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Run
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-6 py-6">
        {isLoading && (
          <div className="flex h-64 items-center justify-center">
            <Spinner size="lg" />
          </div>
        )}

        {isError && (
          <Card>
            <p className="text-sm text-red-600" data-testid="report-detail-error">
              Failed to load report: {(error as Error)?.message ?? "unknown error"}
            </p>
          </Card>
        )}

        {data && (
          <>
            <Card>
              <div className="flex flex-wrap items-baseline gap-x-12 gap-y-4">
                <Summary label="Iteration" value={String(data.iteration)} />
                <Summary
                  label="Composite (mean)"
                  value={data.composite_mean.toFixed(3)}
                />
                <Summary
                  label="Pass rate ≥ 0.6"
                  value={formatPercent(data.pass_rate_at_0_6, 0)}
                />
                <Summary label="Cost" value={formatUSD(data.cost.usd_spent)} />
                <Summary
                  label="Latency p95"
                  value={`${data.latency.p95_total_ms.toFixed(0)} ms`}
                />
                <div className="ml-auto text-xs tabular-nums text-slate-400">
                  {data.timestamp}
                </div>
              </div>
            </Card>

            <Card title="Full IterationReport">
              <pre
                className="overflow-x-auto rounded-xl bg-slate-50 p-4 text-xs leading-relaxed"
                data-testid="report-json"
              >
                <code dangerouslySetInnerHTML={{ __html: highlightJson(data) }} />
              </pre>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimal hand-rolled JSON syntax highlighter
//
// JSON.stringify gives us a canonical token stream — keys are always `"..."`
// followed by `:`, strings are always `"..."`, numbers, booleans, and `null`
// have well-defined regexes. We escape the source first so user-supplied
// strings can't inject HTML, then wrap tokens in spans with Tailwind colors.
// Colors per the spec:
//   keys     -> slate-700
//   strings  -> emerald-700
//   numbers  -> indigo-700
// ---------------------------------------------------------------------------

export function highlightJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) return "";
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Order matters: match strings (including keys) before numbers, booleans,
  // and null, because keys are a special kind of string.
  return escaped.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g,
    (_match, strLit, colon, num, lit) => {
      if (strLit) {
        if (colon) {
          // Key
          return `<span class="text-slate-700 font-medium">${strLit}</span>${colon}`;
        }
        return `<span class="text-emerald-700">${strLit}</span>`;
      }
      if (num) {
        return `<span class="text-indigo-700">${num}</span>`;
      }
      if (lit) {
        return `<span class="text-violet-700">${lit}</span>`;
      }
      return _match;
    },
  );
}
