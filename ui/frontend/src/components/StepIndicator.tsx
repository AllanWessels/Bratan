import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { STEP_TITLES, type StepNum } from "@/store/setupStore";

interface StepIndicatorProps {
  current: StepNum;
  completed: number[];
}

const steps: StepNum[] = [1, 2, 3, 4, 5, 6, 7, 8];

export function StepIndicator({ current, completed }: StepIndicatorProps) {
  return (
    <nav aria-label="Setup steps" className="flex flex-col gap-1">
      {steps.map((s) => {
        const isCurrent = s === current;
        const isComplete = completed.includes(s);
        return (
          <Link
            key={s}
            to={`/setup/${s}`}
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors",
              isCurrent
                ? "bg-brand-50 text-brand-700"
                : "text-slate-600 hover:bg-slate-100",
            )}
          >
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                isCurrent
                  ? "bg-brand-600 text-white"
                  : isComplete
                    ? "bg-emerald-500 text-white"
                    : "bg-slate-200 text-slate-600",
              )}
              aria-hidden="true"
            >
              {isComplete && !isCurrent ? <Check className="h-3.5 w-3.5" /> : s}
            </span>
            <span className={cn("font-medium", isCurrent && "text-brand-800")}>
              {STEP_TITLES[s]}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
