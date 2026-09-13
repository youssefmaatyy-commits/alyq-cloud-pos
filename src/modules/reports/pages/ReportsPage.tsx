import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  AlertIcon,
  BoxIcon,
  Button,
  Card,
  ExportButton,
  HistoryIcon,
  LayersIcon,
  LoadingBlock,
  ReceiptIcon,
  ReportIcon,
  SectionTitle,
  StatTile,
  UsersIcon,
  WalletIcon,
  WarehouseIcon,
} from "@/components/ui";
import { withinDateRange } from "@/lib/export";
import { useCatalog } from "@/modules/products/hooks/CatalogProvider";
import { categoryNameIndex } from "@/modules/products/services/categoryTree";
import { buildProductsSheets } from "@/modules/products/services/productsExport";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { EMPTY_INVENTORY_FILTERS, queryInventory } from "@/modules/inventory/services/inventoryQuery";
import { buildInventorySheets } from "@/modules/inventory/services/inventoryExport";
import { usePos } from "@/modules/pos/hooks/PosProvider";
import { SALES_ROW_CAP } from "@/modules/pos/data";
import type { Sale } from "@/modules/pos/types";
import { buildSalesSheets } from "@/modules/pos/services/salesExport";
import { useCustomers } from "@/modules/customers/hooks/CustomerProvider";
import { buildCustomersSheets } from "@/modules/customers/services/customersExport";
import { useReturns } from "@/modules/returns/hooks/ReturnProvider";
import { useExpenses } from "@/modules/expenses/hooks/ExpenseProvider";
import { useShifts } from "@/modules/shifts/hooks/ShiftProvider";
import {
  buildCashLedger,
  buildCashMovementsSheets,
  buildFinancialSheets,
  buildPaymentsSheets,
  computeFinancialTotals,
  paymentCountOf,
} from "../services/financialExport";
import { buildSuppliersSheets } from "../services/suppliersExport";
import { toTimestampBounds } from "../services/dateRanges";
import { assertCanViewReports } from "../services/reportAccess";
import { deniedMessageKey } from "@/lib/permissions/enforce";
import {
  DateRangePicker,
  EMPTY_DATE_RANGE,
  toExportRange,
  type DateRangeValue,
  type RangePreset,
} from "../components/DateRangePicker";

/**
 * Reports & data export — the backup/extract hub.
 *
 * Everything here is **read-only**: the page renders numbers the providers
 * already hold and hands the export builders the same rows, so a report can
 * never disagree with the screen it came from. No repository is called, nothing
 * is written, and no new capability is required — the screen sits behind the
 * existing `view_shifts` read capability that `/expenses` and `/shifts` use.
 *
 * The date range applies to the time-series data (sales, payments, the financial
 * report, cash movements, supplier activity). Master data — products, inventory, customers — is
 * exported whole, because "current stock" and "the customer book" have no
 * meaningful range.
 */
export function ReportsPage() {
  const { t, pick, money, lang } = useI18n();
  const navigate = useNavigate();
  const { products: catalogProducts, categories } = useCatalog();
  const { products: inventoryProducts, movements, loading: inventoryLoading } = useInventory();
  const { sales, salesLoading, repository } = usePos();
  const { customers, loading: customersLoading } = useCustomers();
  const { returnsList, refundsList, loading: returnsLoading } = useReturns();
  const { expenses } = useExpenses();
  const { shifts, summaryFor } = useShifts();

  const [range, setRange] = useState<DateRangeValue>(EMPTY_DATE_RANGE);
  const [preset, setPreset] = useState<RangePreset | null>("allTime");

  const exportRange = useMemo(() => toExportRange(range), [range]);
  const nameIndex = useMemo(() => categoryNameIndex(categories, pick), [categories, pick]);
  const categoryName = useMemo(
    () => (id: string | null) => (id ? nameIndex.get(id) ?? "—" : t("products.withoutCategory")),
    [nameIndex, t],
  );

  // ── range-filtered sets ─────────────────────────────────────────────────
  // ── ranged sales read ────────────────────────────────────────────────────
  // The provider's list is a window sized for the till. A report can be asked
  // for a period far wider than that window, and filtering a capped list in the
  // browser under-reports without saying so: the number on screen reads as a
  // quiet month instead of a truncated read. So the range is pushed down to the
  // database through the same repository the till uses — no second data path, no
  // fork of the sales contract — and the exact count comes back beside it so the
  // page can state its own coverage.
  const bounds = useMemo(() => toTimestampBounds(exportRange), [exportRange]);
  const [rangedRead, setRangedRead] = useState<{ sales: Sale[]; total: number | null } | null>(null);
  const [rangedLoading, setRangedLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRangedLoading(true);
    void (async () => {
      try {
        const [list, total] = await Promise.all([
          repository.listSales({ from: bounds.from, to: bounds.to, limit: SALES_ROW_CAP }),
          repository.countSales({ from: bounds.from, to: bounds.to }),
        ]);
        if (!cancelled) setRangedRead({ sales: list, total });
      } catch {
        // A failed ranged read must not blank the page. Falling back to the
        // till's window keeps the screen usable, and the coverage line below
        // still says how much of the period is missing.
        if (!cancelled) setRangedRead(null);
      } finally {
        if (!cancelled) setRangedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, bounds.from, bounds.to]);

  /**
   * What the exports are built from. The builders apply their own range filter,
   * so this only widens what they can see — it never decides the edges for them.
   */
  const reportSales = useMemo(() => rangedRead?.sales ?? sales, [rangedRead, sales]);

  const rangedSales = useMemo(
    () =>
      reportSales.filter((sale) =>
        withinDateRange(sale.created_at, exportRange.from, exportRange.to),
      ),
    [reportSales, exportRange],
  );

  /**
   * True when the period holds more sales than this read returned. The count is
   * exact and comes from the database; the comparison is the only honest way to
   * tell a small period from a capped one.
   */
  const coverageTruncated =
    rangedRead !== null && rangedRead.total !== null && rangedRead.total > rangedSales.length;
  const rangedExpenses = useMemo(
    () =>
      expenses.filter((expense) =>
        withinDateRange(expense.spent_at, exportRange.from, exportRange.to),
      ),
    [expenses, exportRange],
  );
  const rangedReturns = useMemo(
    () =>
      returnsList.filter((record) =>
        withinDateRange(record.created_at, exportRange.from, exportRange.to),
      ),
    [returnsList, exportRange],
  );
  const rangedRefunds = useMemo(
    () =>
      refundsList.filter((record) =>
        withinDateRange(record.created_at, exportRange.from, exportRange.to),
      ),
    [refundsList, exportRange],
  );

  const totals = useMemo(
    () =>
      computeFinancialTotals({
        sales: rangedSales,
        products: catalogProducts,
        expenses: rangedExpenses,
        returnsList: rangedReturns,
        refundsList: rangedRefunds,
      }),
    [rangedSales, catalogProducts, rangedExpenses, rangedReturns, rangedRefunds],
  );

  // Stock rows exactly as the Inventory screen computes them (tracked products).
  const stockRows = useMemo(
    () => queryInventory(inventoryProducts, EMPTY_INVENTORY_FILTERS, categoryName),
    [inventoryProducts, categoryName],
  );

  // Payment lines and cash movements the two standalone exports will write.
  // Counted with the very functions the exports use, so the number on the button
  // and the rows in the file cannot disagree.
  const rangedShifts = useMemo(
    () =>
      shifts.filter((shift) =>
        withinDateRange(shift.opening_at, exportRange.from, exportRange.to),
      ),
    [shifts, exportRange],
  );
  const paymentLines = paymentCountOf(rangedSales);
  const cashMovements = buildCashLedger({
    sales: rangedSales,
    expenses: rangedExpenses,
    refundsList: rangedRefunds,
    shifts: rangedShifts,
    t,
  });

  const loading =
    salesLoading || rangedLoading || inventoryLoading || customersLoading || returnsLoading;

  const financialRows =
    rangedSales.length +
    rangedExpenses.length +
    rangedReturns.length +
    rangedRefunds.length +
    shifts.length;
  const supplierRows = movements.length + rangedExpenses.length;

  const mayReadReports = useMemo(() => {
    try {
      assertCanViewReports();
      return true;
    } catch {
      return false;
    }
  }, []);

  const applyPreset = (next: RangePreset) => setPreset(next);

  // The route guard decides who reaches this screen; the service decides who may
  // read a report. Asking the service is what makes the two agree when a custom
  // role grants the screen but withholds `view_reports` — and the refusal is the
  // same one the export buttons would give, in the same words. The assertion runs
  // in a memo rather than during render so a denial paints a panel instead of
  // throwing into the nearest error boundary.
  if (!mayReadReports) {
    return (
      <div>
        <PageHeader title={t("reports.title")} subtitle={t("reports.subtitle")} />
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
        title={t("reports.title")}
        subtitle={t("reports.subtitle")}
        actions={<ReportIcon className="h-5 w-5 text-indigo-600" />}
      />

      {loading ? (
        <Card>
          <LoadingBlock label={t("common.loading")} />
        </Card>
      ) : (
        <div className="space-y-4">
          {/* ── Coverage ────────────────────────────────────────────────────
              A read has a ceiling, and the page says so when the period on
              screen exceeds it. Every number below is computed from the sales
              actually fetched, so without this line a truncated range would
              simply look like a slow month. */}
          {coverageTruncated && (
            <Card>
              <div className="flex items-start gap-2">
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <p className="text-sm font-semibold text-slate-800">
                    {t("reports.salesCoverage", {
                      shown: rangedSales.length,
                      total: rangedRead?.total ?? rangedSales.length,
                    })}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600">{t("reports.salesCoverageHint")}</p>
                </div>
              </div>
            </Card>
          )}
          {/* ── Date range ─────────────────────────────────────────────── */}
          <Card>
            <SectionTitle>{t("reports.rangeTitle")}</SectionTitle>
            <p className="mb-3 text-xs font-medium text-slate-600">{t("reports.rangeHint")}</p>
            <DateRangePicker
              value={range}
              onChange={setRange}
              activePreset={preset}
              onPreset={applyPreset}
            />
          </Card>

          {/* ── The range at a glance ──────────────────────────────────── */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={t("reports.revenue")}
              value={money(totals.revenue)}
              tone="success"
              icon={<WalletIcon />}
              hint={`${totals.invoiceCount} ${t("reports.invoices").toLowerCase()}`}
            />
            <StatTile
              label={t("reports.netProfit")}
              value={money(totals.netProfit)}
              tone={totals.netProfit >= 0 ? "primary" : "danger"}
              icon={<ReportIcon />}
              hint={t("export.metric.grossProfit")}
            />
            <StatTile
              label={t("reports.expenses")}
              value={money(totals.expenses)}
              tone="warning"
              icon={<ReceiptIcon />}
              hint={`${rangedExpenses.length} ${t("export.col.count").toLowerCase()}`}
            />
            <StatTile
              label={t("export.metric.refundsPaid")}
              value={money(totals.refundsPaid)}
              tone="neutral"
              icon={<LayersIcon />}
              hint={`${totals.refundsCount} ${t("export.col.count").toLowerCase()}`}
            />
          </div>

          {/* ── Financial report ───────────────────────────────────────── */}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <SectionTitle>{t("reports.financialTitle")}</SectionTitle>
                <p className="mt-1 text-xs font-medium text-slate-600">
                  {t("reports.financialHint")}
                </p>
                <p className="mt-1 text-[11px] font-semibold text-slate-500">
                  {t("export.dateRange")}:{" "}
                  {exportRange.from || exportRange.to
                    ? `${exportRange.from ?? "…"} → ${exportRange.to ?? "…"}`
                    : t("export.range.allTime")}
                </p>
              </div>
              <ExportButton
                name="financial-report"
                authority="report"
                count={financialRows}
                variant="primary"
                build={() =>
                  buildFinancialSheets({
                    sales: reportSales,
                    products: catalogProducts,
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
            </div>
          </Card>

          {/* ── Advanced reports ───────────────────────────────────────── */}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <SectionTitle>{t("reports.adv.title")}</SectionTitle>
                <p className="mt-1 text-xs font-medium text-slate-600">
                  {t("reports.adv.subtitle")}
                </p>
              </div>
              {/* The analysis lives on its own screen and reads this one's date
                  window; the hub stays the place raw extracts come from. */}
              <Button variant="secondary" size="sm" onClick={() => navigate("/reports/advanced")}>
                <ReportIcon className="h-4 w-4" />
                {t("nav.advancedReports")}
              </Button>
            </div>
          </Card>

          {/* ── Data exports ───────────────────────────────────────────── */}
          <Card>
            <SectionTitle>{t("reports.dataTitle")}</SectionTitle>
            <p className="mb-3 text-xs font-medium text-slate-600">{t("reports.dataHint")}</p>

            <div className="grid gap-3 md:grid-cols-2">
              <ExportRow
                icon={<ReceiptIcon />}
                title={t("export.sheet.invoices")}
                hint={`${rangedSales.length} ${t("reports.invoices").toLowerCase()}`}
              >
                <ExportButton
                  name="sales"
                  size="sm"
                  count={rangedSales.length}
                  build={() => buildSalesSheets({ sales: rangedSales, t, pick })}
                />
              </ExportRow>

              <ExportRow
                icon={<WarehouseIcon />}
                title={t("export.sheet.inventory")}
                hint={`${stockRows.length} ${t("export.col.currentQty").toLowerCase()}`}
              >
                <ExportButton
                  name="inventory"
                  size="sm"
                  count={stockRows.length}
                  build={() =>
                    buildInventorySheets({ products: stockRows, categoryName, t, pick })
                  }
                />
              </ExportRow>

              <ExportRow
                icon={<BoxIcon />}
                title={t("export.sheet.products")}
                hint={`${catalogProducts.length} ${t("export.col.product").toLowerCase()}`}
              >
                <ExportButton
                  name="products"
                  size="sm"
                  count={catalogProducts.length}
                  build={() =>
                    buildProductsSheets({ products: catalogProducts, categories, t, pick })
                  }
                />
              </ExportRow>

              <ExportRow
                icon={<UsersIcon />}
                title={t("export.sheet.customers")}
                hint={`${customers.length} ${t("export.col.customer").toLowerCase()}`}
              >
                <ExportButton
                  name="customers"
                  size="sm"
                  count={customers.length}
                  build={() => buildCustomersSheets({ customers, sales, t })}
                />
              </ExportRow>

              <ExportRow
                icon={<WalletIcon />}
                title={t("export.sheet.payments")}
                hint={`${paymentLines} ${t("export.sheet.payments").toLowerCase()}`}
              >
                <ExportButton
                  name="payments"
                  size="sm"
                  count={paymentLines}
                  build={() => buildPaymentsSheets({ sales: rangedSales, range: exportRange, t })}
                />
              </ExportRow>

              <ExportRow
                icon={<HistoryIcon />}
                title={t("export.sheet.cashLedger")}
                hint={`${cashMovements.length} ${t("export.sheet.cashLedger").toLowerCase()}`}
              >
                <ExportButton
                  name="cash-movements"
                  size="sm"
                  count={cashMovements.length}
                  build={() =>
                    buildCashMovementsSheets({
                      sales: rangedSales,
                      expenses: rangedExpenses,
                      refundsList: rangedRefunds,
                      shifts,
                      range: exportRange,
                      t,
                    })
                  }
                />
              </ExportRow>
            </div>
          </Card>

          {/* ── Purchases & suppliers (derived) ────────────────────────── */}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <SectionTitle>{t("reports.suppliersTitle")}</SectionTitle>
                <p className="mt-1 text-xs font-medium text-slate-600">
                  {t("reports.suppliersHint")}
                </p>
              </div>
              <ExportButton
                name="purchases-suppliers"
                authority="report"
                size="sm"
                count={supplierRows}
                build={() =>
                  buildSuppliersSheets({
                    movements,
                    expenses: rangedExpenses,
                    products: catalogProducts,
                    range: exportRange,
                    t,
                    pick,
                  })
                }
              />
            </div>
          </Card>

          <p className="px-1 text-[11px] font-medium text-slate-500">
            {t("export.note.generatedBy", { app: t("app.name") })} · {lang.toUpperCase()}
          </p>
        </div>
      )}
    </div>
  );
}

/** One labelled row in the data-export grid. */
function ExportRow({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
          <p className="truncate text-[11px] font-medium text-slate-500">{hint}</p>
        </div>
      </div>
      {children}
    </div>
  );
}
