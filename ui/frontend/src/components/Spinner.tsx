import { cn } from "@/lib/cn";

interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
  label?: string;
}

const sizeMap = {
  sm: "h-4 w-4 border-2",
  md: "h-6 w-6 border-2",
  lg: "h-10 w-10 border-[3px]",
};

export function Spinner({ size = "md", className, label }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label ?? "Loading"}
      className={cn(
        "inline-block animate-spin rounded-full border-slate-300 border-t-brand-600",
        sizeMap[size],
        className,
      )}
    />
  );
}
