/**
 * Advanced reports (Phase 14, requirement 7).
 *
 * The Reports hub answers "give me the file". This screen answers the questions
 * somebody asks *before* they know which file they want: who sold the most, what
 * stopped moving, which customer owes us, which drawer was short, what the month
 * actually made. Eight reports, one date window, one permission.
 *
 * It is a reading surface over the existing providers and the existing
 * arithmetic — the profit tab additionally lists realized online orders once
 * (promo codes and delivery fees), and nothing here computes a figure a second
 * time:
 *
 *   · sales / product / customer / expense / shift numbers come from the
 *     analytics services, which are the same functions the export buttons call,
 *     so a table and its spreadsheet cannot drift apart;
 *   · the financial tab is `computeFinancialTotals` — the reports hub's own
 *     summary — with the refund impact laid next to the profit it reduces;
 *   · the raw extracts (every invoice row, the whole customer book, the stock
 *     list) stay on the Reports hub, behind `export_data`. This screen's buttons
 *     are all `authority="report"`, which asserts `export_reports`.
 *
 * Reading it is gated twice, the way the hub is: the route guard decides who
 * reaches the screen, and `assertCanViewReports()` decides who may see numbers —
 * so a custom role that grants the screen but withholds `view_reports` gets the
 * same denial in the same words it would get from an export button.
 */
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Card,
  ExportButton,
  LayersIcon,
  LoadingBlock,
  ReceiptIcon,
  ReportIcon,
  SectionTitle,
  StatTile,
  WalletIcon,
} from "@/components/ui";
import { deniedMessageKey } from "@/lib/permissions/enforce";
import { useCatalog } from "@/modules/products/hooks/CatalogProvider";
import { usePos } from "@/modules/pos/hooks/PosProvider";
import { useCustomers } from "@/modules/customers/hooks/CustomerProvider";
import { useExpenses } from "@/modules/expenses/hooks/ExpenseProvider";
import { useReturns } from "@/modules/returns/hooks/ReturnProvider";
import { useShifts } from "@/modules/shifts/hooks/ShiftProvider";
import { getOnlineOrdersRepository } from "@/modules/online/data";
import type { OnlineOrder } from "@/modules/online/types";
import { withinDateRange } from "@/lib/export";
import { assertCanViewReports } from "../services/reportAccess";
import { computeFinancialTotals, buildFinancialSheets, type FinancialTotals } from "../services/financialExport";
import { fetchFinancialSummary } from "../services/reportAggregates";
import {
  DateRangePicker,
  EMPTY_DATE_RANGE,
  toExportRange,
  type DateRangeValue,
  type RangePreset,
} from "../components/DateRangePicker";
import { ReportSection, ReportTabs } from "../components/ReportTable";
import { SalesReportTab } from "../components/tabs/SalesReportTab";
import { ProductReportTab } from "../components/tabs/ProductReportTab";
import { CustomerReportTab } from "../components/tabs/CustomerReportTab";
import { ExpenseReportTab } from "../components/tabs/ExpenseReportTab";
import { ShiftReportTab } from "../components/tabs/ShiftReportTab";
import { VariantReportTab } from "../components/tabs/VariantReportTab";
import { ProfitabilityTab } from "../components/tabs/ProfitabilityTab";
import type { ReportTabProps } from "../components/tabs/types";

type TabId =
  | "sales"
  | "products"
  | "variants"
  | "customers"
  | "expenses"
  | "shifts"
  | "financial"
  | "profit";

export function AdvancedReportsPage() {
  const { t, money, num, lang } = useI18n();
  const { products, variants } = useCatalog();
  const { sales, salesLoading } = usePos();
  const { customers, loading: customersLoading } = useCustomers();
  const { expenses } = useExpenses();
  const { returnsList, refundsList, loading: returnsLoading } = useReturns();
  const { shifts, summaryFor } = useShifts();
  const [orders, setOrders] = useState<OnlineOrder[]>([]);

  const [tab, setTab] = useState<TabId>("sales");
  // Everything is in scope to begin with, and no preset is highlighted: a
  // button that looks active while the window is unbounded would promise a
  // filter the tables are not applying.
  const [range, setRange] = useState<DateRangeValue>(EMPTY_DATE_RANGE);
  const [preset, setPreset] = useState<RangePreset | null>(null);

  const exportRange = useMemo(() => toExportRange(range), [range]);
  const applyPreset = (next: RangePreset) => setPreset(next);

  const tabProps: ReportTabProps = useMemo(
    () => ({
      range: exportRange,
      sales,
      products,
      variants,
      returns: returnsList,
      orders,
      customers,
      expenses,
      shifts,
      summaryFor,
      pick: (arabic: string | null | undefined, english: string | null | undefined) =>
        lang === "ar" ? arabic || english || "" : english || arabic || "",
    }),
    [exportRange, sales, products, variants, returnsList, orders, customers, expenses, shifts, summaryFor, lang],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await getOnlineOrdersRepository().listOrders({ limit: null });
        if (!cancelled) setOrders(list);
      } catch {
        if (!cancelled) setOrders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The financial picture, from the hub's own totals — including what the
  // refunds took back out of it, which is the figure nobody can see elsewhere.
  const clientFinancial = useMemo(() => {
    const inRange = (iso: string | null | undefined) =>
      withinDateRange(iso, exportRange.from, exportRange.to);
    return computeFinancialTotals({
      sales: sales.filter((sale) => inRange(sale.created_at)),
      products,
      expenses: expenses.filter((expense) => inRange(expense.spent_at)),
      returnsList: returnsList.filter((record) => inRange(record.created_at)),
      refundsList: refundsList.filter((record) => inRange(record.created_at)),
    });
  }, [sales, products, expenses, returnsList, refundsList, exportRange]);

  /**
   * The same totals as the DATABASE added them up, or null when it could not —
   * demo mode, a project whose migrations predate 0032, a caller without
   * `view_reports`. Null is the signal to fall back, never a zero.
   *
   * Phase 22.1 gave this to the reports hub and not to this page, which left the
   * two screens able to disagree about the same month: this page reads the
   * providers' rows, and those are capped at SALES_ROW_CAP, so a period holding
   * more invoices than that showed a smaller revenue here than on `/reports`
   * for the identical window. Same shape, same differential suite holding both
   * sides to the same values, so nothing downstream has to know which arrived.
   */
  const [dbFinancial, setDbFinancial] = useState<FinancialTotals | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const aggregated = await fetchFinancialSummary({
          from: exportRange.from || null,
          to: exportRange.to || null,
        });
        if (!cancelled) setDbFinancial(aggregated.ok ? aggregated.value : null);
      } catch {
        // `fetchFinancialSummary` reports its failures rather than throwing, so
        // this is the unexpected case; falling back keeps the screen readable.
        if (!cancelled) setDbFinancial(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The window is passed as its two strings, not as the object: a new object
    // identity on every render would re-run the read.
  }, [exportRange.from, exportRange.to]);

  const financial = dbFinancial ?? clientFinancial;

  const netAfterRefunds = Math.round((financial.netProfit - financial.refundsPaid) * 100) / 100;

  const loading = salesLoading || customersLoading || returnsLoading;

  const mayReadReports = useMemo(() => {
    try {
      assertCanViewReports();
      return true;
    } catch {
      return false;
    }
  }, []);

  if (!mayReadReports) {
    return (
      <div>
        <PageHeader title={t("reports.adv.title")} subtitle={t("reports.adv.subtitle")} />
        <Card>
          <p className="text-sm font-medium text-slate-700">
            {t(deniedMessageKey("view_reports") as Parameters<typeof t>[0])}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("reports.adv.title")}
        subtitle={t("reports.adv.subtitle")}
        actions={<ReportIcon className="h-5 w-5 text-indigo-600" />}
      />

      {loading ? (
        <Card>
          <LoadingBlock label={t("common.loading")} />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <SectionTitle>{t("reports.rangeTitle")}</SectionTitle>
            <p className="mb-3 text-xs font-medium text-slate-600">{t("reports.adv.rangeHint")}</p>
            <DateRangePicker
              value={range}
              onChange={setRange}
              activePreset={preset}
              onPreset={applyPreset}
            />
          </Card>

          <Card>
            <ReportTabs<TabId>
              active={tab}
              onChange={setTab}
              tabs={[
                { id: "sales", label: t("reports.adv.tabSales"), count: sales.length },
                { id: "products", label: t("reports.adv.tabProducts"), count: products.length },
                { id: "variants", label: t("reports.adv.tabVariants"), count: variants.length },
                { id: "customers", label: t("reports.adv.tabCustomers"), count: customers.length },
                { id: "expenses", label: t("reports.adv.tabExpenses"), count: expenses.length },
                { id: "shifts", label: t("reports.adv.tabShifts"), count: shifts.length },
                { id: "financial", label: t("reports.adv.tabFinancial") },
                { id: "profit", label: t("reports.adv.tabProfit") },
              ]}
            />
          </Card>

          {tab === "sales" ? <SalesReportTab {...tabProps} /> : null}
          {tab === "products" ? <ProductReportTab {...tabProps} /> : null}
          {tab === "variants" ? <VariantReportTab {...tabProps} /> : null}
          {tab === "customers" ? <CustomerReportTab {...tabProps} /> : null}
          {tab === "expenses" ? <ExpenseReportTab {...tabProps} /> : null}
          {tab === "shifts" ? <ShiftReportTab {...tabProps} /> : null}
          {tab === "profit" ? <ProfitabilityTab {...tabProps} /> : null}

          {tab === "financial" ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                  label={t("export.metric.revenue")}
                  value={money(financial.revenue)}
                  tone="success"
                  icon={<WalletIcon />}
                  hint={`${num(financial.invoiceCount)} ${t("reports.invoices").toLowerCase()}`}
                />
                <StatTile
                  label={t("export.metric.grossProfit")}
                  value={money(financial.grossProfit)}
                  tone="primary"
                  icon={<LayersIcon />}
                  hint={`${t("export.metric.cogs")}: ${money(financial.cogs)}`}
                />
                <StatTile
                  label={t("export.metric.expenses")}
                  value={money(financial.expenses)}
                  tone="warning"
                  icon={<ReceiptIcon />}
                />
                <StatTile
                  label={t("export.metric.netProfit")}
                  value={money(financial.netProfit)}
                  tone={financial.netProfit >= 0 ? "success" : "danger"}
                  hint={`${t("reports.adv.netAfterRefunds")}: ${money(netAfterRefunds)}`}
                />
              </div>

              <Card>
                <ReportSection
                  title={t("reports.adv.refundImpact")}
                  hint={t("reports.adv.refundImpactHint")}
                  aside={
                    /* The hub's own financial workbook — this tab does not have a
                       second builder for the same document. */
                    <ExportButton
                      name="financial-report"
                      authority="report"
                      size="sm"
                      count={
                        financial.invoiceCount + financial.returnsCount + financial.refundsCount
                      }
                      build={() =>
                        buildFinancialSheets({
                          sales,
                          products,
                          expenses,
                          returnsList,
                          refundsList,
                          shifts,
                          summaryFor,
                          range: exportRange,
                          t,
                        })
                      }
                    />
                  }
                >
                  <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Figure label={t("export.metric.returns")} value={money(financial.returnsTotal)} hint={num(financial.returnsCount)} />
                    <Figure label={t("export.metric.refundsPaid")} value={money(financial.refundsPaid)} hint={num(financial.refundsCount)} />
                    <Figure label={t("export.metric.refundsPending")} value={money(financial.refundsPending)} tone="warning" />
                    <Figure
                      label={t("reports.adv.netAfterRefunds")}
                      value={money(netAfterRefunds)}
                      tone={netAfterRefunds >= 0 ? "success" : "danger"}
                      hint={t("reports.adv.netAfterRefundsHint")}
                    />
                    <Figure label={t("export.metric.voided")} value={money(financial.voidedTotal)} hint={num(financial.voidedCount)} />
                    <Figure label={t("export.metric.unsettled")} value={money(financial.unsettled)} tone="warning" />
                    <Figure label={t("export.metric.cash")} value={money(financial.cash)} />
                    <Figure label={t("export.metric.card")} value={money(financial.card + financial.instapay)} />
                  </dl>
                </ReportSection>
              </Card>
            </div>
          ) : null}

          <p className="px-1 text-[11px] font-medium text-slate-500">
            {t("export.note.generatedBy", { app: t("app.name") })} · {lang.toUpperCase()}
          </p>
        </div>
      )}
    </div>
  );
}

/** One labelled figure in the financial tab's grid. */
function Figure({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-emerald-700"
      : tone === "warning"
        ? "text-amber-700"
        : tone === "danger"
          ? "text-rose-700"
          : "text-slate-900";
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
      <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={`mt-1 text-base font-bold ${toneClass}`} dir="ltr">
        {value}
      </dd>
      {hint ? <p className="mt-0.5 text-[11px] font-medium text-slate-500">{hint}</p> : null}
    </div>
  );
}
