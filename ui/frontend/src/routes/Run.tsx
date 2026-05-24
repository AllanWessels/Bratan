import { Link } from "react-router-dom";
import { ArrowLeft, Play, Square } from "lucide-react";
import { useMemo, useState } from "react";
import {
  useConfig,
  useLatestReport,
  useLoopStatus,
  useLoopStream,
  useReportHistory,
  useStartLoop,
  useStopLoop,
} from "@/api/hooks";
import type { IterationReport, ReportSummary, StopReason } from "@/api/types";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Field, TextInput } from "@/components/Field";
import { Spinner } from "@/components/Spinner";
import { formatPercent, formatUSD, prettyFailureCategory } from "@/lib/format";
import { cn } from "@/lib/cn";

export function Run() {
  const cfg = useConfig();
  const latest = useLatestReport();
  const history = useReportHistory();
  const status = useLoopStatus();
  const stream = useLoopStream();

  if (cfg.isLoading || latest.isLoading || history.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  const series = buildSeries(history.data ?? [], stream.reports, latest.data ?? null);
  const current = stream.reports.length > 0 ? stream.reports[stream.reports.length - 1] : latest.data ?? null;
  const previous = series.length >= 2 ? series[series.length - 2] : null;
  const delta = current && previous ? current.composite_mean - previous.composite_mean : null;
  const budgetUSD = cfg.data?.cost.usd_per_run ?? null;
  const stopReason = stream.lastStopReason ?? (current?.stop_reason ?? null);
  const running = status.data?.running ?? false;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4">
          <Link to="/" className="block">
            <h1 className="text-lg font-semibold text-slate-900">Bratan</h1>
            <p className="text-xs text-slate-500">Live run dashboard</p>
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            <Link
              to="/authoring"
              className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-slate-700 hover:bg-slate-100"
            >
              <ArrowLeft className="h-4 w-4" /> Authoring
            </Link>
            <Link
              to="/settings"
              className="rounded-xl bg-white px-3 py-2 text-slate-700 hover:bg-slate-100"
            >
              Settings
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-6 py-6">
        <TopBar
          current={current}
          delta={delta}
          stopReason={stopReason}
          running={running}
          streamConnected={stream.connected}
        />

        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Composite over time" className="lg:col-span-2">
            <CompositeChart points={series} />
          </Card>

          <Card title="Cost meter">
            <CostMeter current={current} budgetUSD={budgetUSD} />
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Per-category">
            <PerCategoryBars current={current} />
          </Card>

          <Card title="Regressions (last iteration)">
            <RegressionList current={current} />
          </Card>
        </div>

        <RunControls running={running} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function TopBar({
  current,
  delta,
  stopReason,
  running,
  streamConnected,
}: {
  current: IterationReport | null;
  delta: number | null;
  stopReason: StopReason | null;
  running: boolean;
  streamConnected: boolean;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-x-12 gap-y-4">
        <Metric
          label="Composite (mean)"
          value={current ? current.composite_mean.toFixed(3) : "—"}
          sub={
            delta !== null ? (
              <span className={cn(delta > 0 ? "text-emerald-600" : delta < 0 ? "text-red-600" : "text-slate-400")}>
                {delta >= 0 ? "+" : ""}
                {delta.toFixed(3)} vs prior
              </span>
            ) : null
          }
        />
        <Metric
          label="Pass rate ≥ 0.6"
          value={current ? formatPercent(current.pass_rate_at_0_6, 0) : "—"}
        />
        <Metric
          label="Iteration"
          value={current ? String(current.iteration) : "—"}
          sub={current ? `${current.test_set_size} cases` : null}
        />
        <Metric
          label="Latency p95"
          value={current ? `${current.latency.p95_total_ms.toFixed(0)} ms` : "—"}
        />
        <div className="ml-auto flex items-center gap-2">
          <StatusDot running={running} streamConnected={streamConnected} />
          {stopReason && <StopBadge reason={stopReason} />}
        </div>
      </div>
    </Card>
  );
}

function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs tabular-nums text-slate-500">{sub}</div>}
    </div>
  );
}

function StatusDot({ running, streamConnected }: { running: boolean; streamConnected: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-600">
      <span
        className={cn(
          "inline-block h-2.5 w-2.5 rounded-full",
          running ? "animate-pulse bg-emerald-500" : "bg-slate-300",
        )}
      />
      {running ? "Running" : "Idle"}
      <span className="text-slate-400">·</span>
      <span className={streamConnected ? "text-slate-600" : "text-slate-400"}>
        {streamConnected ? "live" : "offline"}
      </span>
    </div>
  );
}

const STOP_BADGE_STYLES: Record<StopReason, string> = {
  convergence: "bg-emerald-100 text-emerald-800",
  budget: "bg-amber-100 text-amber-800",
  max_iterations: "bg-slate-200 text-slate-800",
  anchor_regression: "bg-red-100 text-red-800",
  judge_drift: "bg-violet-100 text-violet-800",
  blue_stall: "bg-red-100 text-red-800",
  manual: "bg-slate-100 text-slate-700",
};

function StopBadge({ reason }: { reason: StopReason }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium",
        STOP_BADGE_STYLES[reason] ?? "bg-slate-100 text-slate-700",
      )}
      data-testid="stop-badge"
    >
      stop: {reason.replace(/_/g, " ")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Composite chart — hand-rolled SVG
// ---------------------------------------------------------------------------

interface ChartPoint {
  iteration: number;
  composite_mean: number;
}

function CompositeChart({ points }: { points: ChartPoint[] }) {
  const width = 640;
  const height = 220;
  const padding = { top: 16, right: 16, bottom: 28, left: 36 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  if (points.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-slate-400">
        No iterations yet. Start a run below to plot progress.
      </div>
    );
  }

  const iterations = points.map((p) => p.iteration);
  const xMin = Math.min(...iterations);
  const xMax = Math.max(...iterations);
  const xSpan = Math.max(1, xMax - xMin);
  const yMin = 0;
  const yMax = 1;

  const x = (it: number) => padding.left + ((it - xMin) / xSpan) * innerW;
  const y = (v: number) => padding.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.iteration).toFixed(2)} ${y(p.composite_mean).toFixed(2)}`)
    .join(" ");

  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Composite metric over iterations"
        className="h-56 w-full"
        data-testid="composite-chart"
        data-points={points.length}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(t)}
              y2={y(t)}
              stroke="#e2e8f0"
              strokeDasharray="2 3"
            />
            <text x={padding.left - 6} y={y(t) + 4} textAnchor="end" className="fill-slate-400" fontSize="10">
              {t.toFixed(2)}
            </text>
          </g>
        ))}

        <line
          x1={padding.left}
          x2={padding.left}
          y1={padding.top}
          y2={height - padding.bottom}
          stroke="#cbd5e1"
        />
        <line
          x1={padding.left}
          x2={width - padding.right}
          y1={height - padding.bottom}
          y2={height - padding.bottom}
          stroke="#cbd5e1"
        />

        <path d={pathD} fill="none" stroke="#2563eb" strokeWidth={2} />

        {points.map((p) => (
          <circle
            key={`${p.iteration}-${p.composite_mean}`}
            cx={x(p.iteration)}
            cy={y(p.composite_mean)}
            r={3}
            fill="#2563eb"
            data-testid="chart-point"
          />
        ))}

        {points.map((p) => (
          <text
            key={`label-${p.iteration}`}
            x={x(p.iteration)}
            y={height - padding.bottom + 14}
            textAnchor="middle"
            className="fill-slate-500"
            fontSize="10"
          >
            {p.iteration}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost meter
// ---------------------------------------------------------------------------

function CostMeter({
  current,
  budgetUSD,
}: {
  current: IterationReport | null;
  budgetUSD: number | null;
}) {
  const spent = current?.cost.usd_spent ?? 0;
  const cap = budgetUSD ?? 0;
  const ratio = cap > 0 ? Math.min(1, spent / cap) : 0;
  const overrun = cap > 0 && spent > cap;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-semibold tabular-nums text-slate-900">{formatUSD(spent)}</span>
        <span className="text-xs text-slate-500">budget {cap > 0 ? formatUSD(cap) : "—"}</span>
      </div>
      <div className="h-3 w-full rounded-full bg-slate-200" role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={cn("h-full rounded-full transition-all", overrun ? "bg-red-500" : "bg-brand-600")}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <dl className="grid grid-cols-2 gap-y-1 text-xs text-slate-600">
        <dt>Oracle calls</dt>
        <dd className="text-right tabular-nums">{current?.cost.oracle_calls ?? 0}</dd>
        <dt>Pre-judge calls</dt>
        <dd className="text-right tabular-nums">{current?.cost.prejudge_calls ?? 0}</dd>
        <dt>Cache hits</dt>
        <dd className="text-right tabular-nums">{current?.cost.cache_hits ?? 0}</dd>
        <dt>Tokens in / out</dt>
        <dd className="text-right tabular-nums">
          {(current?.cost.tokens_in ?? 0).toLocaleString()} /{" "}
          {(current?.cost.tokens_out ?? 0).toLocaleString()}
        </dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-category bars
// ---------------------------------------------------------------------------

function PerCategoryBars({ current }: { current: IterationReport | null }) {
  const entries = useMemo(() => {
    if (!current) return [];
    return Object.entries(current.per_category).sort(
      (a, b) => a[1].avg_composite - b[1].avg_composite,
    );
  }, [current]);

  if (entries.length === 0) {
    return <p className="text-sm text-slate-400">No per-category data yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {entries.map(([cat, stats]) => {
        const width = Math.max(2, Math.min(100, stats.avg_composite * 100));
        const tone =
          stats.avg_composite >= 0.6
            ? "bg-emerald-500"
            : stats.avg_composite >= 0.4
            ? "bg-amber-500"
            : "bg-red-500";
        return (
          <li key={cat}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="font-medium text-slate-700">{prettyFailureCategory(cat)}</span>
              <span className="tabular-nums text-slate-500">
                {stats.avg_composite.toFixed(2)} · {stats.count} cases · {formatPercent(stats.pass_rate, 0)} pass
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-100">
              <div className={cn("h-full rounded-full", tone)} style={{ width: `${width}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Regression list
// ---------------------------------------------------------------------------

function RegressionList({ current }: { current: IterationReport | null }) {
  if (!current || current.regressions.length === 0) {
    return <p className="text-sm text-slate-400">No regressions detected in the last iteration.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
          <th className="pb-2">Case</th>
          <th className="pb-2 text-right">Previous</th>
          <th className="pb-2 text-right">Current</th>
          <th className="pb-2 text-right">Δ</th>
        </tr>
      </thead>
      <tbody>
        {current.regressions.map((r) => {
          const diff = r.current - r.previous;
          return (
            <tr key={r.case_id} className="border-t border-slate-100">
              <td className="py-2 font-mono text-xs text-slate-700">{r.case_id}</td>
              <td className="py-2 text-right tabular-nums">{r.previous.toFixed(2)}</td>
              <td className="py-2 text-right tabular-nums">{r.current.toFixed(2)}</td>
              <td className="py-2 text-right tabular-nums text-red-600">{diff.toFixed(2)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Run controls
// ---------------------------------------------------------------------------

function RunControls({ running }: { running: boolean }) {
  const [iterations, setIterations] = useState(1);
  const [budgetUSD, setBudgetUSD] = useState<string>("");
  const [skipRed, setSkipRed] = useState(false);
  const [noAgents, setNoAgents] = useState(false);

  const start = useStartLoop();
  const stop = useStopLoop();

  const submit = () => {
    const budget = budgetUSD.trim() === "" ? null : Number(budgetUSD);
    start.mutate({
      iterations,
      budget_usd: budget !== null && Number.isFinite(budget) ? budget : null,
      skip_red: skipRed,
      no_agents: noAgents,
    });
  };

  return (
    <Card title="Run controls">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Iterations" className="w-28">
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={0}
              value={iterations}
              onChange={(e) => setIterations(Math.max(0, Number(e.target.value || 0)))}
              disabled={running}
            />
          )}
        </Field>
        <Field label="Budget USD (optional)" className="w-44" hint="Leave blank for none">
          {(id) => (
            <TextInput
              id={id}
              type="number"
              step="0.01"
              min={0}
              value={budgetUSD}
              onChange={(e) => setBudgetUSD(e.target.value)}
              disabled={running}
              placeholder="e.g. 5.00"
            />
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={skipRed}
            onChange={(e) => setSkipRed(e.target.checked)}
            disabled={running}
          />
          Skip red team
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={noAgents}
            onChange={(e) => setNoAgents(e.target.checked)}
            disabled={running}
          />
          No agents (eval only)
        </label>
        <div className="ml-auto flex gap-2">
          {running ? (
            <Button
              variant="danger"
              onClick={() => stop.mutate()}
              loading={stop.isPending}
              data-testid="stop-button"
            >
              <Square className="h-4 w-4" /> Stop loop
            </Button>
          ) : (
            <Button onClick={submit} loading={start.isPending} data-testid="start-button">
              <Play className="h-4 w-4" /> Start loop
            </Button>
          )}
        </div>
      </div>
      {start.isError && (
        <p className="mt-3 text-sm text-red-600">{(start.error as Error).message}</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSeries(
  history: ReportSummary[],
  streamed: IterationReport[],
  latest: IterationReport | null,
): ChartPoint[] {
  const map = new Map<string, ChartPoint>();

  for (const h of history) {
    map.set(keyOf(h.iteration, h.timestamp), {
      iteration: h.iteration,
      composite_mean: h.composite_mean,
    });
  }
  for (const r of streamed) {
    map.set(keyOf(r.iteration, r.timestamp), {
      iteration: r.iteration,
      composite_mean: r.composite_mean,
    });
  }
  if (latest) {
    map.set(keyOf(latest.iteration, latest.timestamp), {
      iteration: latest.iteration,
      composite_mean: latest.composite_mean,
    });
  }

  return Array.from(map.values()).sort((a, b) => a.iteration - b.iteration);
}

function keyOf(iter: number, ts: string): string {
  return `${iter}::${ts}`;
}
