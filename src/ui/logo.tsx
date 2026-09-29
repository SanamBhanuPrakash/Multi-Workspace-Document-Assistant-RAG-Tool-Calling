import { cn } from "./cn";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={cn("size-7", className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-ink" />
      <g className="stroke-panel" strokeWidth="1.6" strokeLinecap="round" opacity=".5">
        <path d="M8 8v16M16 8v16M24 8v16M8 8h16M8 16h16M8 24h16" />
      </g>
      <circle cx="16" cy="16" r="3.2" className="fill-brand" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 font-semibold tracking-tight text-ink", className)}>
      <LogoMark />
      <span className="text-[17px]">Lattice</span>
    </span>
  );
}
