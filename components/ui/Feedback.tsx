import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent",
        className,
      )}
    />
  );
}

export function LoadingBlock({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-3 py-16 text-sm font-medium text-slate-600", className)}>
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  icon = "📭",
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-2xl">
        <span aria-hidden>{icon}</span>
      </div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {description ? <p className="max-w-md text-sm text-slate-600">{description}</p> : null}
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel,
}: {
  title: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="mx-4 my-6 flex flex-col items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-6 py-10 text-center"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-100 text-xl text-rose-600">
        <span aria-hidden>⚠️</span>
      </div>
      <h3 className="text-base font-semibold text-rose-900">{title}</h3>
      {message ? <p className="max-w-md text-sm font-medium text-rose-700">{message}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        "alyq-card",
        padded && "p-4 sm:p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600">{children}</h2>
      {aside}
    </div>
  );
}

type Tone = "neutral" | "success" | "danger" | "info" | "warning";

const TONES: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-300",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-300",
  danger: "bg-rose-50 text-rose-700 ring-rose-300",
  info: "bg-sky-50 text-sky-800 ring-sky-300",
  warning: "bg-amber-50 text-amber-800 ring-amber-300",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * KPI tile — clarified hierarchy: accent edge -> uppercase label -> large value
 * -> optional secondary line. `hint` is plain high-contrast text; pass `badge`
 * only when a status pill is genuinely required.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
  badge,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone | "primary";
  icon?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="alyq-kpi" data-tone={tone}>
      <div className="flex items-start justify-between gap-2">
        <p className="alyq-kpi-label">{label}</p>
        {icon ? (
          <span aria-hidden className="shrink-0 text-slate-500">
            {icon}
          </span>
        ) : null}
      </div>
      <p className="alyq-kpi-value">{value}</p>
      {hint ? <p className="alyq-kpi-hint">{hint}</p> : null}
      {badge ? <div className="mt-2">{badge}</div> : null}
    </div>
  );
}
