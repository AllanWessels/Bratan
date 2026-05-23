import { useEffect } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { useUIStore, type ToastVariant } from "@/store/uiStore";
import { cn } from "@/lib/cn";

const variantStyles: Record<ToastVariant, { wrap: string; icon: JSX.Element }> = {
  success: {
    wrap: "bg-emerald-50 border-emerald-200 text-emerald-900",
    icon: <CheckCircle2 className="h-5 w-5 text-emerald-600" />,
  },
  error: {
    wrap: "bg-red-50 border-red-200 text-red-900",
    icon: <AlertCircle className="h-5 w-5 text-red-600" />,
  },
  info: {
    wrap: "bg-slate-50 border-slate-200 text-slate-900",
    icon: <Info className="h-5 w-5 text-slate-600" />,
  },
};

export function ToastViewport() {
  const toasts = useUIStore((s) => s.toasts);
  const dismiss = useUIStore((s) => s.dismissToast);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} id={t.id} message={t.message} variant={t.variant} onDismiss={dismiss} />
      ))}
    </div>
  );
}

interface ToastCardProps {
  id: string;
  message: string;
  variant: ToastVariant;
  onDismiss: (id: string) => void;
}

function ToastCard({ id, message, variant, onDismiss }: ToastCardProps) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(id), 4000);
    return () => clearTimeout(t);
  }, [id, onDismiss]);

  const styles = variantStyles[variant];

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-xl border bg-white p-3 shadow-md",
        styles.wrap,
      )}
      role="status"
    >
      <span className="mt-0.5">{styles.icon}</span>
      <p className="flex-1 text-sm">{message}</p>
      <button
        type="button"
        onClick={() => onDismiss(id)}
        aria-label="Dismiss notification"
        className="rounded-md p-1 text-slate-500 hover:bg-white/40 hover:text-slate-900"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
