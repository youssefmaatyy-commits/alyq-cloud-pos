/**
 * Report furniture — the table and the tab bar the advanced reports share.
 *
 * Five reports, twelve tables. Without one component to render them, each table
 * would be thirty lines of the same `<th>` classes, and the twelfth would differ
 * from the first in some small way nobody intended — a right-aligned number here,
 * a missing hover state there. So the shape lives here once:
 *
 *   · `ReportTable` renders a header, the rows, an optional totals footer and an
 *     empty state. Columns carry their own `render`, which is what keeps the
 *     money formatting, the badges and the bilingual names in the caller's hands
 *     while the layout stays identical everywhere.
 *   · `ReportTabs` is the segmented control the Returns screen already uses, with
 *     the same classes, so switching reports looks like the rest of the app.
 *
 * Neither component fetches, filters or computes anything. They are handed rows.
 */
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";

export interface ReportColumn<T> {
  /** Stable key for React and for the totals row alignment. */
  key: string;
  label: string;
  /** Numbers read better right-aligned; the first column never is. */
  align?: "start" | "end";
  render(row: T): ReactNode;
}

export function ReportTable<T>({
  columns,
  rows,
  rowKey,
  totals,
  emptyLabel,
  emptyHint,
  footerNote,
  dense = false,
}: {
  columns: ReportColumn<T>[];
  rows: readonly T[];
  rowKey(row: T, index: number): string;
  /** One cell per column, in order — rendered as a totals row under the data. */
  totals?: readonly ReactNode[];
  emptyLabel: string;
  emptyHint?: string;
  footerNote?: string;
  dense?: boolean;
}) {
  const cellPad = dense ? "px-3 py-2" : "px-3 py-2.5";

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-8 text-center">
        <p className="text-sm font-semibold text-slate-700">{emptyLabel}</p>
        {emptyHint ? <p className="mt-1 text-xs font-medium text-slate-500">{emptyHint}</p> : null}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-600">
            {columns.map((column, index) => (
              <th
                key={column.key}
                className={`${cellPad} font-semibold ${
                  index === 0 ? "text-start" : column.align === "end" ? "text-end" : "text-start"
                }`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60"
            >
              {columns.map((column, columnIndex) => (
                <td
                  key={column.key}
                  className={`${cellPad} ${
                    columnIndex === 0
                      ? "text-start font-semibold text-slate-800"
                      : column.align === "end"
                        ? "text-end text-slate-700"
                        : "text-start text-slate-600"
                  } text-xs`}
                  dir={column.align === "end" ? "ltr" : undefined}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totals ? (
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50 text-xs font-bold text-slate-800">
              {columns.map((column, index) => (
                <td
                  key={column.key}
                  className={`${cellPad} ${index === 0 ? "text-start" : column.align === "end" ? "text-end" : "text-start"}`}
                  dir={column.align === "end" ? "ltr" : undefined}
                >
                  {totals[index] ?? null}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
      {footerNote ? (
        <p className="border-t border-slate-100 bg-slate-50/60 px-3 py-2 text-[11px] font-medium text-slate-500">
          {footerNote}
        </p>
      ) : null}
    </div>
  );
}

export interface ReportTab<T extends string> {
  id: T;
  label: string;
  /** Optional count in the tab's pill — how many rows that report holds. */
  count?: number;
}

export function ReportTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly ReportTab<T>[];
  active: T;
  onChange(id: T): void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1" role="tablist">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={`rounded-lg px-4 py-1.5 text-xs font-bold transition-all ${
              selected ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {tab.label}
            {typeof tab.count === "number" ? <span className="ms-1 opacity-70">({tab.count})</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A section heading with an optional control on the right (usually an export). */
export function ReportSection({
  title,
  hint,
  aside,
  children,
}: {
  title: string;
  hint?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-slate-900">{title}</h3>
          {hint ? <p className="mt-0.5 text-[11px] font-medium text-slate-500">{hint}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A percentage, printed the way the rest of the app prints one. */
export function usePercent() {
  const { num } = useI18n();
  return (value: number | null | undefined) => `${num(value ?? 0, 1)}%`;
}
