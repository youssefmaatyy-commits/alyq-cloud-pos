/**
 * Variants report — what each COMBINATION did, per colour and per size.
 *
 * The products tab answers "how did the PRODUCT sell" and reads stock from the
 * rollup; this tab answers the question it cannot: which combination moved,
 * which came back, and which shelf is sitting on the money. The two are
 * deliberately NOT additive — every Gold / 17 unit is also a Ring unit, so
 * adding the tabs together would count the same ring twice.
 *
 * Rows come from `reports_variant_performance` (0043) wherever there is a
 * database to ask — one RPC covers every invoice in the window, whatever the
 * till's row cap holds. Where there is not (demo mode, a project whose
 * migrations predate 0043, a seat without `view_reports`), the same arithmetic
 * runs over the rows the providers already hold, and the section says which
 * source produced the numbers — a fallback that reads identically is a fallback
 * nobody can audit.
 *
 * Margins are derived here with the app's own `share()`, never in the database —
 * one definition of margin per app.
 */
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, Card, ExportButton, LoadingBlock, StatTile } from "@/components/ui";
import {
  buildSheets,
  withinDateRange,
  type BuiltSheet,
  type ExportSheet,
} from "@/lib/export";
import { sizeLabelOf } from "@/modules/products/variants";
import { roundMoney } from "@/modules/expenses/validation";
import { salesInRange, share } from "../../services/salesAnalytics";
import {
  computeVariantPerformance,
  fetchVariantPerformance,
  type VariantPerformanceRow,
} from "../../services/variantPerformance";
import { ReportSection, ReportTable, type ReportColumn } from "../ReportTable";
import type { ReportTabProps } from "./types";

const TOP_LIMIT = 25;

type Source =
  | { status: "pending" }
  | { status: "database"; rows: VariantPerformanceRow[] }
  | { status: "client" };

export function VariantReportTab({ range, sales, products, variants, returns, pick }: ReportTabProps) {
  const { t, money, num } = useI18n();

  // ── the database's answer, over EVERY invoice in the window ──────────────
  const [source, setSource] = useState<Source>({ status: "pending" });
  // The range travels as its two strings: a new object identity per render
  // would re-ask the database on every keystroke elsewhere on the page.
  const { from, to } = range;
  useEffect(() => {
    let cancelled = false;
    setSource({ status: "pending" });
    void fetchVariantPerformance({ from, to }).then((result) => {
      if (cancelled) return;
      setSource(
        result.ok
          ? { status: "database", rows: result.value }
          : { status: "client" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  // ── the fallback: the same arithmetic over rows the providers hold ───────
  const clientRows = useMemo(
    () =>
      computeVariantPerformance({
        sales: salesInRange(sales, range),
        returns: (returns ?? []).filter((candidate) =>
          withinDateRange(candidate.created_at, range.from, range.to),
        ),
        variants: variants ?? [],
        products,
      }),
    [sales, returns, variants, products, range],
  );

  const rows: VariantPerformanceRow[] =
    source.status === "database" ? source.rows : clientRows;
  const waiting = source.status === "pending";

  const totalUnits = rows.reduce((sum, row) => sum + row.units, 0);
  const totalRevenue = roundMoney(rows.reduce((sum, row) => sum + row.revenue, 0));
  const totalReturnedUnits = rows.reduce((sum, row) => sum + row.returnedUnits, 0);
  const totalStockValue = roundMoney(rows.reduce((sum, row) => sum + row.stockValue, 0));
  const onShelf = rows.reduce((sum, row) => sum + row.stock, 0);

  const columns: ReportColumn<VariantPerformanceRow>[] = [
    {
      key: "combination",
      label: t("export.col.variant"),
      render: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-3 w-3 shrink-0 rounded-full border border-slate-300"
          />
          {pick(row.colorAr, row.colorEn) || t("store.variants.defaultColor")}
          <span className="font-black text-slate-400">/</span>
          <span className="tabular-nums">{sizeLabelOf(row.size, row.sizeLabel)}</span>
          {!row.active ? (
            <Badge tone="neutral">{t("products.variants.statusArchived")}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "product",
      label: t("export.col.product"),
      render: (row) => (
        <span className="text-slate-600">
          {pick(row.productNameAr, row.productNameEn)}
          <span className="ms-1.5 font-mono text-[10px] text-slate-400">{row.productSku}</span>
        </span>
      ),
    },
    { key: "sku", label: t("export.col.sku"), render: (row) => <span className="font-mono text-[11px]">{row.sku}</span> },
    { key: "invoices", label: t("reports.invoices"), align: "end", render: (row) => num(row.invoices) },
    { key: "units", label: t("export.col.unitsSold"), align: "end", render: (row) => num(row.units) },
    { key: "revenue", label: t("export.col.revenue"), align: "end", render: (row) => money(row.revenue) },
    { key: "cost", label: t("export.col.unitCost"), align: "end", render: (row) => money(row.cost) },
    {
      key: "profit",
      label: t("export.col.profit"),
      align: "end",
      render: (row) => {
        const profit = roundMoney(row.revenue - row.cost);
        return (
          <span className={profit < 0 ? "font-semibold text-rose-700" : "text-slate-800"}>
            {money(profit)}
          </span>
        );
      },
    },
    {
      key: "margin",
      label: t("export.col.margin"),
      align: "end",
      render: (row) => `${num(share(roundMoney(row.revenue - row.cost), row.revenue), 1)}%`,
    },
    {
      key: "returned",
      label: t("reports.adv.variantsReturned"),
      align: "end",
      render: (row) =>
        row.returnedUnits > 0
          ? `${num(row.returnedUnits)} · ${money(row.returnedAmount)}`
          : "—",
    },
    { key: "stock", label: t("reports.adv.variantsOnShelf"), align: "end", render: (row) => num(row.stock) },
  ];

  const top = [...rows].sort((a, b) => b.revenue - a.revenue).slice(0, TOP_LIMIT);

  const buildSheetsFor = (): BuiltSheet[] => {
    const sheet: ExportSheet<VariantPerformanceRow> = {
      name: t("export.sheet.variants"),
      rows,
      columns: [
        {
          header: t("export.col.variant"),
          value: (row) =>
            [
              pick(row.colorAr, row.colorEn) || "",
              sizeLabelOf(row.size, row.sizeLabel),
            ]
              .filter(Boolean)
              .join(" / "),
          width: 18,
        },
        { header: t("export.col.product"), value: (row) => pick(row.productNameAr, row.productNameEn), width: 28 },
        { header: t("export.col.sku"), value: (row) => row.sku, width: 20 },
        { header: t("reports.invoices"), value: (row) => row.invoices, kind: "number" },
        { header: t("export.col.unitsSold"), value: (row) => row.units, kind: "number" },
        { header: t("export.col.revenue"), value: (row) => row.revenue, kind: "money" },
        { header: t("export.col.unitCost"), value: (row) => row.cost, kind: "money" },
        { header: t("export.col.profit"), value: (row) => roundMoney(row.revenue - row.cost), kind: "money" },
        { header: t("reports.adv.variantsReturned"), value: (row) => row.returnedUnits, kind: "number" },
        { header: t("reports.adv.variantsOnShelf"), value: (row) => row.stock, kind: "number" },
        {
          header: t("export.col.stockValue"),
          value: (row) => row.stockValue,
          kind: "money",
        },
      ],
      notes: [
        t("export.note.generatedBy", { app: t("app.name") }),
        source.status === "database"
          ? t("reports.adv.variantsSourceDb")
          : t("reports.adv.variantsSourceClient"),
      ],
    };
    return buildSheets([sheet]);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("export.col.unitsSold")}
          value={num(totalUnits)}
          tone="primary"
          hint={`${rows.length} ${t("export.col.variantSku").toLowerCase()}`}
        />
        <StatTile
          label={t("export.col.revenue")}
          value={money(totalRevenue)}
          tone="success"
          hint={t("reports.adv.variantsHintShort")}
        />
        <StatTile
          label={t("reports.adv.variantsReturned")}
          value={num(totalReturnedUnits)}
          tone="warning"
          hint={t("reports.adv.variantsReturnedHint")}
        />
        <StatTile
          label={t("export.sheet.stockValue")}
          value={money(totalStockValue)}
          tone="info"
          hint={`${num(onShelf)} ${t("reports.adv.variantsOnShelf").toLowerCase()}`}
        />
      </div>

      <Card className="space-y-4">
        <ReportSection
          title={t("reports.adv.variantsTitle")}
          hint={
            source.status === "database"
              ? t("reports.adv.variantsSourceDb")
              : t("reports.adv.variantsSourceClient")
          }
          aside={
            rows.length > 0 ? (
              <ExportButton
                name="variant-report"
                authority="report"
                size="sm"
                count={rows.length}
                build={buildSheetsFor}
              />
            ) : null
          }
        >
          {waiting ? (
            <LoadingBlock label={t("common.loading")} />
          ) : (
            <ReportTable
              columns={columns}
              rows={top}
              rowKey={(row) => row.variantId}
              dense
              emptyLabel={t("reports.adv.empty")}
              emptyHint={t("reports.adv.variantsEmptyHint")}
              footerNote={
                rows.length > TOP_LIMIT ? t("reports.adv.topN", { count: TOP_LIMIT }) : undefined
              }
              totals={[
                t("reports.adv.total"),
                "",
                "",
                num(rows.reduce((sum, row) => sum + row.invoices, 0)),
                num(totalUnits),
                money(totalRevenue),
                money(roundMoney(rows.reduce((sum, row) => sum + row.cost, 0))),
                money(roundMoney(rows.reduce((sum, row) => sum + row.revenue - row.cost, 0))),
                "",
                num(totalReturnedUnits),
                num(onShelf),
              ]}
            />
          )}
        </ReportSection>
      </Card>
    </div>
  );
}
