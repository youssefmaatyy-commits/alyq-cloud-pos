import { useMemo, type ReactNode } from "react";

/**
 * Dashboard charts (Phase 14, requirement 8) — dependency-free SVG.
 *
 * The app has no charting library and adding one would put a second opinion
 * about money, dates and rounding next to the modules that already hold them.
 * These four primitives draw exactly the shapes the requirement asks for — a
 * trend line, paired bars, a donut and ranked bars — out of plain SVG paths,
 * and they are deliberately presentational: they take already-computed numbers
 * and render them, so every figure on the dashboard still comes from the same
 * analytics the reports read.
 *
 * Two RTL notes. The drawing surface is pinned to `dir="ltr"` so a chart reads
 * left-to-right (oldest to newest) in both languages — an axis that mirrors
 * with the page would make the trend lie about which end is "today". Labels,
 * legends and money figures stay outside the SVG, in normal document flow, so
 * they translate and mirror like any other text.
 */

/** Categorical palette — fixed hex, not Tailwind classes, so fills survive
 * inside SVG and the same slice keeps the same colour across re-renders. */
export const CHART_COLORS = [
  "#4f46e5", // indigo
  "#0d9488", // teal
  "#d97706", // amber
  "#e11d48", // rose
  "#7c3aed", // violet
  "#0284c7", // sky
  "#65a30d", // lime
  "#db2777", // pink
] as const;

const W = 300;
const H = 120;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Chart frame: a titled card body with an optional footnote. */
export function ChartCard({
  title,
  hint,
  legend,
  children,
  empty,
}: {
  title: string;
  hint?: string;
  legend?: ReactNode;
  children: ReactNode;
  empty?: string;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        {legend}
      </div>
      {hint ? <p className="mt-0.5 text-xs font-medium text-slate-600">{hint}</p> : null}
      <div className="mt-3">
        {empty ? (
          <p className="py-8 text-center text-sm text-slate-500">{empty}</p>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

/** A coloured dot + label, used by the legends under every chart. */
export function LegendItem({ color, label, value }: { color: string; label: string; value?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{label}</span>
      {value ? <span className="tabular-nums text-slate-900">{value}</span> : null}
    </span>
  );
}

export interface TrendPoint {
  date: string;
  total: number;
}

/**
 * Sales trend — area + line over one value per day.
 *
 * `preserveAspectRatio="none"` lets the drawing stretch to the card width while
 * `vectorEffect="non-scaling-stroke"` keeps the line a constant 2px, so a wide
 * card does not produce a wide stroke.
 */
export function TrendChart({ points, color = CHART_COLORS[0] }: { points: TrendPoint[]; color?: string }) {
  const { line, area, max } = useMemo(() => {
    const peak = Math.max(1, ...points.map((p) => p.total));
    const stepX = points.length > 1 ? W / (points.length - 1) : W;
    const coords = points.map((p, i) => {
      const x = points.length > 1 ? i * stepX : W / 2;
      const y = H - (p.total / peak) * (H - 8) - 4;
      return { x: round(x), y: round(y) };
    });
    const path = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x},${c.y}`).join(" ");
    const fill = coords.length
      ? `${path} L${coords[coords.length - 1].x},${H} L${coords[0].x},${H} Z`
      : "";
    return { line: path, area: fill, max: peak };
  }, [points]);

  if (points.length === 0) return null;
  const last = points[points.length - 1];
  const lastY = H - (last.total / max) * (H - 8) - 4;

  return (
    <div dir="ltr">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label={points.map((p) => `${p.date}: ${p.total}`).join(", ")}
      >
        {/* baseline + midline so the eye has something to read the height against */}
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#e2e8f0" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="#f1f5f9" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={area} fill={color} opacity="0.12" />
        <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <circle cx={W} cy={round(lastY)} r="3" fill={color} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export interface PairedPoint {
  date: string;
  revenue: number;
  expenses: number;
}

/** Revenue vs expenses — two bars per day, scaled to the larger of the two. */
export function PairedBarsChart({
  points,
  revenueColor = CHART_COLORS[1],
  expenseColor = CHART_COLORS[3],
}: {
  points: PairedPoint[];
  revenueColor?: string;
  expenseColor?: string;
}) {
  const bars = useMemo(() => {
    const peak = Math.max(1, ...points.flatMap((p) => [p.revenue, p.expenses]));
    const slot = W / Math.max(1, points.length);
    const barWidth = Math.max(2, slot * 0.34);
    return points.map((p, i) => {
      const centre = i * slot + slot / 2;
      const rh = (p.revenue / peak) * (H - 10);
      const eh = (p.expenses / peak) * (H - 10);
      return {
        date: p.date,
        rx: round(centre - barWidth - 1),
        rw: round(barWidth),
        ry: round(H - rh),
        rh: round(rh),
        ex: round(centre + 1),
        ew: round(barWidth),
        ey: round(H - eh),
        eh: round(eh),
      };
    });
  }, [points]);

  if (points.length === 0) return null;

  return (
    <div dir="ltr">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label={points.map((p) => `${p.date}: ${p.revenue} / ${p.expenses}`).join(", ")}
      >
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#e2e8f0" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {bars.map((b) => (
          <g key={b.date}>
            <rect x={b.rx} y={b.ry} width={b.rw} height={Math.max(0.5, b.rh)} fill={revenueColor} rx="1" />
            <rect x={b.ex} y={b.ey} width={b.ew} height={Math.max(0.5, b.eh)} fill={expenseColor} rx="1" />
          </g>
        ))}
      </svg>
    </div>
  );
}

export interface DonutSlice {
  label: string;
  value: number;
  color?: string;
}

/**
 * Payment-method distribution — a donut drawn with `stroke-dasharray` on
 * stacked circles, which keeps the maths to one circumference and needs no arc
 * path commands. Segments are laid out clockwise from 12 o'clock.
 */
export function DonutChart({ slices, centreLabel, centreValue }: { slices: DonutSlice[]; centreLabel?: string; centreValue?: string }) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  if (total <= 0 || slices.length === 0) return null;

  return (
    <div className="flex items-center gap-4">
      <div dir="ltr" className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" role="img" aria-label={slices.map((s) => `${s.label}: ${s.value}`).join(", ")}>
          <circle cx="50" cy="50" r={radius} fill="none" stroke="#f1f5f9" strokeWidth="14" />
          {slices.map((slice, i) => {
            const length = (slice.value / total) * circumference;
            const dash = `${round(length)} ${round(circumference - length)}`;
            const currentOffset = -round(offset);
            offset += length;
            return (
              <circle
                key={slice.label}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={slice.color ?? CHART_COLORS[i % CHART_COLORS.length]}
                strokeWidth="14"
                strokeDasharray={dash}
                strokeDashoffset={currentOffset}
              />
            );
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {centreValue ? <span className="text-sm font-bold text-slate-900">{centreValue}</span> : null}
          {centreLabel ? <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{centreLabel}</span> : null}
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {slices.map((slice, i) => (
          <div key={slice.label} className="flex items-center justify-between gap-2">
            <LegendItem color={slice.color ?? CHART_COLORS[i % CHART_COLORS.length]} label={slice.label} />
            <span className="shrink-0 text-[11px] font-bold tabular-nums text-slate-900">
              {Math.round((slice.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface RankBarRow {
  label: string;
  value: number;
  hint?: string;
}

/**
 * Product performance — ranked horizontal bars, longest first.
 *
 * One small SVG per row rather than one tall chart: the product names then stay
 * real text (translated, truncated, mirrored with the page) while the bar itself
 * is still drawn, and each row is independently readable by a screen reader.
 */
export function RankBars({ rows, color = CHART_COLORS[4] }: { rows: RankBarRow[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return null;
  return (
    <ol className="space-y-2">
      {rows.map((row) => (
        <li key={row.label} className="flex items-center gap-2">
          <span className="w-32 shrink-0 truncate text-xs font-semibold text-slate-800" title={row.label}>
            {row.label}
          </span>
          <span dir="ltr" className="flex min-w-0 flex-1">
            <svg
              viewBox="0 0 100 10"
              preserveAspectRatio="none"
              className="h-2.5 w-full"
              role="img"
              aria-label={`${row.label}: ${row.value}`}
            >
              <rect x="0" y="0" width="100" height="10" rx="5" fill="#f1f5f9" />
              <rect
                x="0"
                y="0"
                width={round((row.value / max) * 100)}
                height="10"
                rx="5"
                fill={color}
              />
            </svg>
          </span>
          <span className="w-24 shrink-0 text-end text-[11px] font-bold tabular-nums text-slate-900">
            {row.hint ?? String(row.value)}
          </span>
        </li>
      ))}
    </ol>
  );
}
