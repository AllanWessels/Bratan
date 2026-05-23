import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useConfig } from "@/api/hooks";
import { Spinner } from "@/components/Spinner";
import { Step1ProjectBasics } from "./setup/Step1ProjectBasics";
import { Step2VectorDB } from "./setup/Step2VectorDB";
import { Step3Models } from "./setup/Step3Models";
import { Step4Costs } from "./setup/Step4Costs";
import { Step5SeedTarget } from "./setup/Step5SeedTarget";
import { Step6GPU } from "./setup/Step6GPU";
import { Step7Stopping } from "./setup/Step7Stopping";
import { Step8JudgeWeights } from "./setup/Step8JudgeWeights";
import { cn } from "@/lib/cn";

const SECTIONS = [
  { id: "project", label: "Project", component: Step1ProjectBasics },
  { id: "vector-db", label: "Vector DB", component: Step2VectorDB },
  { id: "models", label: "Models", component: Step3Models },
  { id: "cost", label: "Cost ceilings", component: Step4Costs },
  { id: "seed", label: "Seed target", component: Step5SeedTarget },
  { id: "gpu", label: "GPU", component: Step6GPU },
  { id: "stopping", label: "Stopping criteria", component: Step7Stopping },
  { id: "judge", label: "Judge weights", component: Step8JudgeWeights },
] as const;

export function Settings() {
  const cfg = useConfig();
  const [active, setActive] = useState<(typeof SECTIONS)[number]["id"]>("project");

  const ActiveSection = SECTIONS.find((s) => s.id === active)?.component;

  if (cfg.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl gap-8 px-6 py-10">
      <aside className="w-64 shrink-0">
        <div className="sticky top-10">
          <Link
            to="/authoring"
            className="mb-6 inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
          <h1 className="mb-4 text-xl font-semibold text-slate-900">Settings</h1>
          <nav className="flex flex-col gap-1">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActive(s.id)}
                className={cn(
                  "rounded-xl px-3 py-2 text-left text-sm transition-colors",
                  active === s.id
                    ? "bg-brand-50 text-brand-700"
                    : "text-slate-600 hover:bg-slate-100",
                )}
              >
                {s.label}
              </button>
            ))}
          </nav>
        </div>
      </aside>

      <main className="flex-1">
        {ActiveSection && <ActiveSection config={cfg.data ?? null} />}
      </main>
    </div>
  );
}
