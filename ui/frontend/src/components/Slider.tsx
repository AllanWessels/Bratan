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

/**
 * Slugifies a label for use as a stable `data-testid` suffix.
 *
 * The user-reported "sliders overrun their container" bug happened when the
 * <input type="range"> received `w-full` but the root flex column was *not*
 * also `w-full`. In a parent flexbox the row would lay out at its intrinsic
 * width (which is content-sized for a flex column without `w-full` and
 * `min-w-0`) and the input would then exceed its parent because `w-full`
 * resolved against the wider available width. Fix: pin the column to the
 * parent's width (`w-full`) and let it shrink (`min-w-0`), then make the
 * <input> `box-border` so its padding/border don't push past 100%.
 */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(
  (
    { label, value, min, max, step = 1, onChange, format, hint, className, ...props },
    ref,
  ) => {
    const id = useId();
    const testId = `slider-${slugify(label)}`;
    const pct =
      max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
    return (
      <div
        className={cn("flex w-full min-w-0 flex-col gap-2", className)}
        data-testid={`${testId}-wrapper`}
      >
        <div className="flex w-full items-baseline justify-between gap-2">
          <label htmlFor={id} className="text-sm font-medium text-slate-700">
            {label}
          </label>
          <span className="font-mono text-sm text-slate-700" data-testid={`${testId}-value`}>
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
          data-testid={testId}
          data-percentage={pct.toFixed(2)}
          className="block h-2 w-full max-w-full min-w-0 box-border cursor-pointer appearance-none rounded-lg bg-slate-200 accent-brand-600"
          {...props}
        />
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
    );
  },
);
Slider.displayName = "Slider";
