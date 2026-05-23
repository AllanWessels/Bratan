import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
}

export function Card({ className, title, description, footer, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-slate-200 bg-white shadow-sm",
        className,
      )}
      {...props}
    >
      {(title || description) && (
        <div className="border-b border-slate-100 px-6 pt-6 pb-4">
          {title && <h2 className="text-lg font-semibold text-slate-900">{title}</h2>}
          {description && (
            <p className="mt-1 text-sm text-slate-500">{description}</p>
          )}
        </div>
      )}
      <div className="px-6 py-5">{children}</div>
      {footer && (
        <div className="rounded-b-2xl border-t border-slate-100 bg-slate-50 px-6 py-4">
          {footer}
        </div>
      )}
    </div>
  );
}
