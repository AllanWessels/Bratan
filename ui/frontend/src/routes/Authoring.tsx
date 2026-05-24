import { Link } from "react-router-dom";
import { Activity, Settings as SettingsIcon } from "lucide-react";
import { useConfig, useSeedList } from "@/api/hooks";
import { Spinner } from "@/components/Spinner";
import { CorpusBrowser } from "./authoring/CorpusBrowser";
import { CaseWizard } from "./authoring/CaseWizard";
import { DraftList } from "./authoring/DraftList";
import { cn } from "@/lib/cn";

export function Authoring() {
  const cfg = useConfig();
  const seedList = useSeedList();

  if (cfg.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  const total = seedList.data?.cases.length ?? 0;
  const target = seedList.data?.target_n ?? cfg.data?.project.seed_target_n ?? 50;
  const progress = Math.min(1, target > 0 ? total / target : 0);
  const reached = total >= target;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4">
          <div>
            <Link to="/" className="block">
              <h1 className="text-lg font-semibold text-slate-900">RAG Refiner</h1>
              <p className="text-xs text-slate-500">Seed case authoring</p>
            </Link>
          </div>
          <div className="flex items-center gap-6">
            <div className="w-72">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs font-medium text-slate-600">
                  Progress {total} / {target}
                </span>
                <span className="text-xs font-mono text-slate-500">
                  {(progress * 100).toFixed(0)}%
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-200">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    reached ? "bg-emerald-500" : "bg-brand-600",
                  )}
                  style={{ width: `${progress * 100}%` }}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={target}
                  aria-valuenow={total}
                />
              </div>
            </div>
            <Link
              to="/run"
              className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            >
              <Activity className="h-4 w-4" /> Run
            </Link>
            <Link
              to="/settings"
              className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            >
              <SettingsIcon className="h-4 w-4" /> Settings
            </Link>
          </div>
        </div>
      </header>

      {reached && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-6 py-3 text-sm text-emerald-900">
          You&apos;ve reached the target of {target} cases. Keep going — more cases means
          better signal.
        </div>
      )}

      <div className="mx-auto flex w-full max-w-[1400px] flex-1 gap-6 px-6 py-6">
        <aside className="flex w-72 shrink-0 flex-col gap-6">
          <CorpusBrowser />
          <DraftList />
        </aside>
        <main className="flex-1">
          <CaseWizard />
        </main>
      </div>
    </div>
  );
}
