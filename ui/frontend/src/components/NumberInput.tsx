import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

interface NumberInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "onChange" | "value" | "min" | "max" | "step"
  > {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** Optional explicit testid — defaults to `number-input-<slug(label)>`. */
  "data-testid"?: string;
  /**
   * Short suffix rendered inside the input's right edge (e.g. "USD",
   * "tokens", "seconds"). Purely visual.
   */
  unit?: string;
  /** Optional hint rendered as small slate-500 text below the input. */
  hint?: ReactNode;
  /**
   * Mark the field as required for the form. Renders a small red asterisk
   * next to the label and forwards `required` to the underlying input.
   */
  required?: boolean;
  /**
   * If true, render the optional `format` of the current value as a
   * read-only suffix the same way `unit` is rendered. Mainly for tests
   * that previously inspected the slider's "current value" label.
   */
  formatValue?: (v: number) => string;
}

/**
 * Slugifies a label for use as a stable `data-testid` suffix.
 *
 * Keeps parity with the deleted <Slider> component so existing callers
 * that addressed sliders by their label-derived testid can be migrated
 * with a one-line search/replace.
 */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A plain numeric input wrapped with a label + optional unit suffix +
 * hint + soft out-of-range validation.
 *
 * Design notes:
 *
 *  1. Internal DOM value is held as a *string*. This is what lets users
 *     clear the field, type "0.05", or backspace through "12" to type
 *     "120" without the controlled `value` snapping back mid-keystroke.
 *
 *  2. `onChange(num)` fires whenever the string parses to a finite
 *     number, *even if it's outside [min, max]*. The out-of-range UI
 *     (red border + "Min N, Max N" hint) is purely visual — we do NOT
 *     prevent typing or clamp silently, because both behaviors confuse
 *     users typing a value that has to pass through an invalid prefix
 *     ("1" before "10" when min=10). The parent owns clamping at submit
 *     time if needed.
 *
 *  3. If the parent passes a new `value` that differs from what's parsed
 *     in the internal string, the internal string resets to that value
 *     — but only when they differ as *numbers*, not as text. That way
 *     re-rendering with the same numeric value doesn't trample "0.30"
 *     into "0.3".
 *
 *  4. The native `<input type="number">` provides up/down arrow keys
 *     and clickable steppers (browser-rendered); we don't reimplement
 *     them. We do expose `inputMode="decimal"` so mobile keyboards
 *     surface the right keypad.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      label,
      value,
      min,
      max,
      step = 1,
      onChange,
      unit,
      hint,
      required,
      disabled,
      className,
      formatValue,
      "data-testid": dataTestId,
      "aria-label": ariaLabel,
      ...rest
    },
    ref,
  ) => {
    const id = useId();
    const slug = slugify(label);
    const testId = dataTestId ?? `number-input-${slug}`;
    const [text, setText] = useState<string>(() => String(value));

    // Sync from parent value -> internal text when they disagree numerically.
    useEffect(() => {
      const parsed = Number(text);
      if (text === "" || !Number.isFinite(parsed) || parsed !== value) {
        setText(String(value));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const parsed = text === "" ? NaN : Number(text);
    const isFinite = Number.isFinite(parsed);
    const outOfRange = isFinite && (parsed < min || parsed > max);
    const showError = outOfRange;
    const pct =
      max > min && isFinite
        ? Math.min(100, Math.max(0, ((parsed - min) / (max - min)) * 100))
        : 0;

    const errorHint = `Min ${min}, Max ${max}`;
    const renderedHint = showError ? errorHint : hint;

    function handleChange(next: string) {
      setText(next);
      const n = Number(next);
      // Fire onChange whenever the text parses to a finite number —
      // including out-of-range, so the parent state mirrors what the
      // user sees on screen. The visual red-border + hint signals the
      // problem; the parent can choose to clamp at submit time.
      if (next !== "" && Number.isFinite(n)) {
        onChange(n);
      }
    }

    return (
      <div
        className={cn("flex w-full min-w-0 flex-col gap-1.5", className)}
        data-testid={`${testId}-wrapper`}
      >
        <div className="flex w-full items-baseline justify-between gap-2">
          <label htmlFor={id} className="text-sm font-medium text-slate-700">
            {label}
            {required && <span className="ml-0.5 text-red-600">*</span>}
          </label>
          {formatValue && (
            <span
              className="font-mono text-sm text-slate-700"
              data-testid={`${testId}-value`}
            >
              {formatValue(isFinite ? parsed : value)}
            </span>
          )}
        </div>
        <div
          className={cn(
            "relative flex w-full items-center rounded-xl border bg-white transition-colors",
            "focus-within:ring-2",
            showError
              ? "border-red-500 focus-within:border-red-500 focus-within:ring-red-200"
              : "border-slate-200 focus-within:border-brand-500 focus-within:ring-brand-200",
            disabled && "opacity-50",
          )}
        >
          <input
            ref={ref}
            id={id}
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            value={text}
            disabled={disabled}
            required={required}
            onChange={(e) => handleChange(e.target.value)}
            data-testid={testId}
            data-percentage={pct.toFixed(2)}
            aria-label={ariaLabel ?? label}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={isFinite ? parsed : undefined}
            aria-invalid={showError || undefined}
            className={cn(
              "w-full min-w-0 box-border bg-transparent px-3 py-2 text-sm text-slate-900",
              "outline-none placeholder:text-slate-400",
              unit ? "pr-1" : "",
            )}
            {...rest}
          />
          {unit && (
            <span
              className="select-none pr-3 text-xs text-slate-500"
              data-testid={`${testId}-unit`}
            >
              {unit}
            </span>
          )}
        </div>
        {renderedHint && (
          <p
            className={cn(
              "text-xs",
              showError ? "text-red-600" : "text-slate-500",
            )}
            data-testid={`${testId}-hint`}
          >
            {renderedHint}
          </p>
        )}
      </div>
    );
  },
);
NumberInput.displayName = "NumberInput";
