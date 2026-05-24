import { useState } from "react";
import { Link } from "react-router-dom";
import { Activity, BookOpen, MessageSquare, Settings as SettingsIcon } from "lucide-react";
import { useConfig, useSeedList } from "@/api/hooks";
import { Spinner } from "@/components/Spinner";
import { CorpusBrowser } from "./authoring/CorpusBrowser";
import { CaseWizard } from "./authoring/CaseWizard";
import { CaseWizardFromCorpus } from "./authoring/CaseWizardFromCorpus";
import { DraftList } from "./authoring/DraftList";
import { GeneratedList } from "./authoring/GeneratedList";
import { cn } from "@/lib/cn";

/**
 * Two authoring modes:
 *
 *   - "From the corpus" (default): browse a file, pick a passage, then write
 *     a question + ground-truth against it. The right mental model for
 *     subject-matter experts, who know the content and don't yet know what
 *     question to test.
 *   - "From a question" (legacy): type a question, search for passages, then
 *     write the answer. Kept for users who already know exactly what they
 *     want to test.
 */
type AuthoringMode = "from-corpus" | "from-question";

export function Authoring() {
  const cfg = useConfig();
  const seedList = useSeedList();
  const [mode, setMode] = useState<AuthoringMode>("from-corpus");

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
              <h1 className="text-lg font-semibold text-slate-900">Bratan</h1>
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

      {/* Mode toggle — sits above the wizard so the SME picks the flow first. */}
      <div className="border-b border-slate-200 bg-white">
        <div
          className="mx-auto flex max-w-[1400px] items-center gap-2 px-6 py-3"
          role="tablist"
          aria-label="Authoring mode"
        >
          <ModeTab
            active={mode === "from-corpus"}
            onClick={() => setMode("from-corpus")}
            icon={<BookOpen className="h-4 w-4" />}
            title="From the corpus"
            subtitle="Browse a document, pick a passage, write a question."
          />
          <ModeTab
            active={mode === "from-question"}
            onClick={() => setMode("from-question")}
            icon={<MessageSquare className="h-4 w-4" />}
            title="From a question"
            subtitle="Type a question, search the corpus, write the answer."
          />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[1400px] flex-1 gap-6 px-6 py-6">
        {mode === "from-question" ? (
          <>
            <aside className="flex w-72 shrink-0 flex-col gap-6">
              <CorpusBrowser />
              <DraftList />
              <GeneratedList />
            </aside>
            <main className="flex-1">
              <CaseWizard />
            </main>
          </>
        ) : (
          <>
            {/* Mode A — the file rail lives inside the wizard so the SME's
                focus stays on the picked passage. Drafts + generated-cases
                still belong as a secondary surface. */}
            <main className="flex-1">
              <CaseWizardFromCorpus />
            </main>
            <aside className="hidden w-72 shrink-0 flex-col gap-6 xl:flex">
              <DraftList />
              <GeneratedList />
            </aside>
          </>
        )}
      </div>
    </div>
  );
}

interface ModeTabProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}

function ModeTab({ active, onClick, icon, title, subtitle }: ModeTabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex flex-1 items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
        active
          ? "border-brand-500 bg-brand-50"
          : "border-slate-200 bg-white hover:border-brand-300 hover:bg-brand-50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 shrink-0",
          active ? "text-brand-700" : "text-slate-500",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block text-sm font-semibold",
            active ? "text-brand-900" : "text-slate-800",
          )}
        >
          {title}
        </span>
        <span className="block text-xs text-slate-500">{subtitle}</span>
      </span>
    </button>
  );
}
