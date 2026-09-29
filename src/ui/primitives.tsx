import { Loader2 } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "./cn";

/* ───────────── Button ───────────── */
const button = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,transform,box-shadow] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-brand text-brand-ink shadow-1 hover:brightness-110",
        secondary: "border border-line-strong bg-panel text-ink hover:bg-panel-2",
        ghost: "text-ink-2 hover:bg-panel-2 hover:text-ink",
        danger: "bg-bad text-brand-ink hover:brightness-110",
        soft: "bg-brand-soft text-brand hover:brightness-95",
      },
      size: { sm: "h-8 px-3 text-[13px]", md: "h-10 px-4 text-sm", lg: "h-12 px-6 text-base", icon: "size-9" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button> & { loading?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant, size, loading, disabled, children, type = "button", ...props }, ref) {
  return (
    <button ref={ref} type={type} className={cn(button({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});

/* ───────────── Badge / status pill ───────────── */
const badge = cva("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 tracking-wide", {
  variants: {
    tone: {
      neutral: "border-line bg-panel-2 text-ink-2",
      brand: "border-transparent bg-brand-soft text-brand",
      good: "border-transparent bg-good-soft text-good",
      warn: "border-transparent bg-warn-soft text-warn",
      bad: "border-transparent bg-bad-soft text-bad",
    },
  },
  defaultVariants: { tone: "neutral" },
});
export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

/* ───────────── Surface ───────────── */
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function Card({ className, ...props }, ref) {
  return <div ref={ref} className={cn("rounded-lg border border-line bg-panel shadow-1", className)} {...props} />;
});

/* ───────────── Form fields ───────────── */
const field = "w-full rounded-md border border-line-strong bg-panel px-3 text-ink placeholder:text-ink-3 transition-colors duration-150 hover:border-ink-3 focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(field, "h-10 text-base sm:text-sm", className)} {...props} />; // 16px on mobile prevents iOS zoom-on-focus
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(field, "min-h-11 resize-none py-2.5 text-base sm:text-sm", className)} {...props} />;
});

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string | undefined; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-ink-2">{hint}</p>
      ) : null}
    </div>
  );
}

/* ───────────── Small pieces ───────────── */
export const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border border-line-strong bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{children}</kbd>
);

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn("size-4 animate-spin text-ink-2", className)} aria-label="Loading" />;

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cn("skeleton rounded-md", className)} />;

export function EmptyState({ icon, title, children, action }: { icon: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-xl border border-line bg-panel-2 text-ink-2 [&_svg]:size-5">{icon}</div>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {children ? <p className="max-w-sm text-sm text-ink-2">{children}</p> : null}
      {action}
    </div>
  );
}

/** The workspace identity chip: colour is the workspace's own, so the active tenant is always visible. */
export const WsDot = ({ color, className }: { color: string; className?: string }) => (
  <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full ring-2 ring-panel", className)} style={{ background: color }} />
);
