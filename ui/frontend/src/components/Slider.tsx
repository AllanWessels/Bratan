import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  hint?: string;
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(
  (
    { label, value, min, max, step = 1, onChange, format, hint, className, ...props },
    ref,
  ) => {
    const id = useId();
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <div className="flex items-baseline justify-between">
          <label htmlFor={id} className="text-sm font-medium text-slate-700">
            {label}
          </label>
          <span className="font-mono text-sm text-slate-700">
            {format ? format(value) : value}
          </span>
        </div>
        <input
          ref={ref}
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 accent-brand-600"
          {...props}
        />
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
    );
  },
);
Slider.displayName = "Slider";
