/**
 * Admin design-system primitives (Phase 46).
 *
 * One visual vocabulary for every admin screen:
 *
 *   - {@link KpiTile} — the compact, clickable metric card. Every dashboard or
 *     summary number lives in one of these; when a metric has a destination the
 *     whole tile is a real link (never a dead decoration), and when the viewer
 *     lacks the route's capability it renders inert rather than fake.
 *   - {@link SegmentedTabs} — the underline tab row (orders, categories, product
 *     detail), with roving semantics kept simple: real buttons, `aria-selected`,
 *     arrow keys optional.
 *   - {@link Skeleton} — the shape-of-content loading block.
 */
import { Link } from "react-router-dom";
import { cn } from "@/utils/cn";

export type KpiTone = "primary" | "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASS: Record<KpiTone, string> = {
  primary: "text-stone-900",
  success: "text-emerald-700",
  warning: "text-amber-700",
  danger: "text-rose-700",
  info: "text-sky-700",
  neutral: "text-stone-900",
};

const ICON_TONE: Record<KpiTone, string> = {
  primary: "bg-stone-900 text-[#e8ddc9]",
  success: "bg-emerald-50 text-emerald-700",
  warning: "bg-amber-50 text-amber-700",
  danger: "bg-rose-50 text-rose-700",
  info: "bg-sky-50 text-sky-700",
  neutral: "bg-stone-100 text-stone-600",
};

export interface KpiTileProps {
  label: string;
  value: string;
  icon?: React.ReactNode;
  tone?: KpiTone;
  /** Secondary line under the value (context, not decoration). */
  hint?: string;
  /** Where the metric leads. Omit → the tile renders inert (honest, not fake). */
  to?: string;
  /** Clicking is blocked (permission-aware rendering decides `to` upstream). */
  disabled?: boolean;
  testId?: string;
  /** Emphasise the tile as the page's headline metric. */
  featured?: boolean;
}

export function KpiTile({
  label,
  value,
  icon,
  tone = "primary",
  hint,
  to,
  disabled = false,
  testId,
  featured = false,
}: KpiTileProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">{label}</p>
        {icon ? (
          <span
            aria-hidden
            className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", ICON_TONE[tone])}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <p
        className={cn(
          "mt-1.5 truncate text-xl font-black tabular-nums tracking-tight",
          TONE_CLASS[tone],
          featured && "text-2xl",
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 truncate text-[11px] font-medium text-stone-500">{hint}</p> : null}
    </>
  );

  const shell = cn(
    "group relative rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm transition",
    featured && "ring-1 ring-stone-900/10",
    to && !disabled && "hover:-translate-y-px hover:border-stone-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900",
    disabled && "opacity-60",
  );

  if (to && !disabled) {
    return (
      <Link to={to} className={cn(shell, "block")} data-testid={testId} data-kpi-link="true">
        {body}
        <span
          aria-hidden
          className="pointer-events-none absolute end-3 top-3 hidden text-stone-300 transition group-hover:text-stone-500 group-hover:block"
        >
          →
        </span>
      </Link>
    );
  }
  return (
    <div className={shell} data-testid={testId} aria-disabled={disabled || undefined}>
      {body}
    </div>
  );
}

// ── tabs ────────────────────────────────────────────────────────────────────

export interface SegmentedTab<Key extends string> {
  key: Key;
  label: string;
  count?: number;
  tone?: "danger" | "warning" | "success";
}

export function SegmentedTabs<Key extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  testId,
  className,
}: {
  tabs: SegmentedTab<Key>[];
  value: Key;
  onChange: (key: Key) => void;
  ariaLabel: string;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn("flex gap-1 overflow-x-auto rounded-xl bg-stone-100 p-1", className)}
    >
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.key)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all",
              active ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800",
            )}
          >
            {tab.label}
            {typeof tab.count === "number" ? (
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[10px] font-black tabular-nums",
                  active
                    ? "bg-stone-900 text-white"
                    : tab.tone === "danger"
                      ? "bg-rose-100 text-rose-700"
                      : tab.tone === "warning"
                        ? "bg-amber-100 text-amber-700"
                        : tab.tone === "success"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-stone-200 text-stone-600",
                )}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ── skeleton ────────────────────────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-xl bg-stone-200/70", className)} />;
}

/** A KPI row's worth of skeletons, for the dashboard's first paint. */
export function KpiSkeletonRow({ count = 5 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  );
}
