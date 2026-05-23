import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (id: string) => ReactNode;
  className?: string;
  required?: boolean;
}

export function Field({ label, hint, error, children, className, required }: FieldProps) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </label>
      {children(id)}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

const baseInput =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-200 outline-none transition-colors";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(baseInput, className)} {...props} />
  ),
);
TextInput.displayName = "TextInput";

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(baseInput, "min-h-[80px] resize-y", className)} {...props} />
));
TextArea.displayName = "TextArea";

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(baseInput, "pr-8", className)} {...props}>
    {children}
  </select>
));
Select.displayName = "Select";
