import { cn } from "@/lib/cn";

interface ConnectionBadgeProps {
  state: "idle" | "testing" | "ok" | "fail";
  label?: string;
  latencyMs?: number | null;
}

export function ConnectionBadge({ state, label, latencyMs }: ConnectionBadgeProps) {
  const dot =
    state === "ok"
      ? "bg-emerald-500"
      : state === "fail"
        ? "bg-red-500"
        : state === "testing"
          ? "bg-amber-400 animate-pulse"
          : "bg-slate-300";

  const text =
    label ??
    (state === "ok"
      ? "Connected"
      : state === "fail"
        ? "Failed"
        : state === "testing"
          ? "Testing..."
          : "Not tested");

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
      role="status"
    >
      <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden="true" />
      {text}
      {state === "ok" && latencyMs != null && (
        <span className="text-slate-500">({Math.round(latencyMs)}ms)</span>
      )}
    </span>
  );
}
