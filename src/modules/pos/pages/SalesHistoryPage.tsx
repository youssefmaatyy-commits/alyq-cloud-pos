import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  LoadingBlock,
  SelectInput,
  TextInput,
  SearchIcon,
  useToast,
} from "@/components/ui";
import { usePos } from "../hooks/PosProvider";
import { useReturns } from "@/modules/returns";
import { buildTransactionCenterSheets } from "../services/salesExport";
import { canConfirmPayment } from "../permissions";
import { can } from "@/lib/permissions/enforce";
import { confirmPayment as confirmPaymentAction } from "../services/saleService";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { useBranch } from "@/lib/branch/BranchProvider";
import {
  EMPTY_TRANSACTION_FILTERS,
  searchTransactionCenter,
  type TransactionCenterFilters,
  type TransactionCenterResult,
  type TransactionCenterRow,
} from "../services/transactionCenter";

/**
 * Unified Invoice / Return Center.
 *
 * Live mode sends every query, lifecycle filter and page boundary to PostgreSQL;
 * browser memory is never mistaken for complete history. Each row keeps the
 * SALE → RETURN → REFUND linkage visible and distinguishes money still pending,
 * rejected money and completed settlement.
 */
export function SalesHistoryPage() {
  const { t, pick } = useI18n();
  const toast = useToast();
  const { sales, refreshSales } = usePos();
  const { returnsList, refundsList, refresh: refreshReturns } = useReturns();
  const { current: branch } = useBranch();
  const canViewSales = can("sales.view");
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<TransactionCenterFilters>(() => {
    if (params.get("today") !== "1") return EMPTY_TRANSACTION_FILTERS;
    const today = localDateInput(new Date());
    return { ...EMPTY_TRANSACTION_FILTERS, dateFrom: today, dateTo: today };
  });
  const [result, setResult] = useState<TransactionCenterResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    if (params.get("today") === "1") setParams({}, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    if (!canViewSales) {
      setLoading(false);
      return;
    }
    const sequence = ++requestSequence.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void searchTransactionCenter(filters, { sales, returns: returnsList, refunds: refundsList })
        .then((next) => {
          if (requestSequence.current === sequence) setResult(next);
        })
        .catch((cause) => {
          if (requestSequence.current === sequence) setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (requestSequence.current === sequence) setLoading(false);
        });
    }, filters.query || filters.cashier ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [canViewSales, filters, sales, returnsList, refundsList, refreshToken]);

  const update = <K extends keyof TransactionCenterFilters>(key: K, value: TransactionCenterFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value, page: key === "page" ? Number(value) : 1 }));
  };

  const confirmPayment = async (saleId: string) => {
    setBusyId(saleId);
    try {
      const user = getCurrentUser();
      await confirmPaymentAction(saleId, { user_id: user.id, user_name: user.name });
      await Promise.all([refreshSales({ silent: true }), refreshReturns({ silent: true })]);
      setRefreshToken((value) => value + 1);
      toast.success(t("pos.paymentConfirmed"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("pos.paymentConfirmFailed"));
    } finally {
      setBusyId(null);
    }
  };

  if (!canViewSales) {
    return (
      <EmptyState
        icon="🔒"
        title={t("perm.denied")}
        description={t("permissions.denied.view_sales")}
      />
    );
  }

  return (
    <div>
      <PageHeader
        crumbs={[{ label: t("home.management.title"), to: "/management" }, { label: t("nav.sales") }]}
        title={t("pos.invoiceCenter")}
        subtitle={t("pos.invoiceCenterSubtitle")}
        actions={
          <>
            {(result?.rows.length ?? 0) > 0 ? (
              <ExportButton name="invoice-center-page" count={result?.rows.length ?? 0} build={() => buildTransactionCenterSheets({ rows: result?.rows ?? [], t })} />
            ) : null}
            <Button variant="secondary" onClick={() => setRefreshToken((value) => value + 1)}>⟳</Button>
            <Link to="/pos" className="alyq-btn-primary alyq-cta h-10 gap-2 rounded-xl px-4 text-sm">
              {t("nav.register")}
            </Link>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
        <span className="rounded-lg bg-white px-2 py-1 ring-1 ring-slate-200">⌂ {branch ? pick(branch.name_ar, branch.name_en) : t("pos.branchUnavailable")}</span>
        <span>{t("pos.serverSearchNotice")}</span>
      </div>

      <Card className="mb-4 space-y-3">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <TextInput
            value={filters.query}
            leading={<SearchIcon />}
            onChange={(event) => update("query", event.target.value)}
            placeholder={t("pos.transactionSearchPlaceholder")}
            aria-label={t("common.search")}
            type="search"
            className="xl:col-span-2"
          />
          <TextInput
            value={filters.cashier}
            onChange={(event) => update("cashier", event.target.value)}
            placeholder={t("pos.cashierFilter")}
            aria-label={t("pos.cashierFilter")}
            type="search"
          />
          <SelectInput value={filters.saleStatus} onChange={(event) => update("saleStatus", event.target.value as TransactionCenterFilters["saleStatus"])}>
            <option value="all">{`${t("pos.cols.status")}: ${t("common.all")}`}</option>
            <option value="completed">{t("pos.status.completed")}</option>
            <option value="pending">{t("pos.status.pending")}</option>
            <option value="voided">{t("pos.status.voided")}</option>
          </SelectInput>
          <SelectInput value={filters.refundStatus} onChange={(event) => update("refundStatus", event.target.value as TransactionCenterFilters["refundStatus"])}>
            <option value="all">{`${t("refunds.title")}: ${t("common.all")}`}</option>
            <option value="none">{t("pos.noRefund")}</option>
            <option value="pending">{t("returns.status.pending")}</option>
            <option value="completed">{t("returns.status.completed")}</option>
            <option value="rejected">{t("returns.status.rejected")}</option>
          </SelectInput>
          <SelectInput value={filters.paymentMethod} onChange={(event) => update("paymentMethod", event.target.value as TransactionCenterFilters["paymentMethod"])}>
            <option value="all">{`${t("pos.cols.method")}: ${t("common.all")}`}</option>
            <option value="cash">{t("pos.payment.cash")}</option>
            <option value="instapay">{t("pos.payment.instapay")}</option>
            <option value="visa">{t("pos.payment.visa")}</option>
            <option value="cod">{t("pos.payment.cod")}</option>
          </SelectInput>
          <SelectInput value={filters.paymentStatus} onChange={(event) => update("paymentStatus", event.target.value as TransactionCenterFilters["paymentStatus"])}>
            <option value="all">{t("pos.allPaymentStatuses")}</option>
            <option value="paid">{t("pos.status.paid")}</option>
            <option value="pending">{t("pos.status.pending")}</option>
          </SelectInput>
          <input type="date" value={filters.dateFrom} onChange={(event) => update("dateFrom", event.target.value)} aria-label={t("returns.filterDateFrom")} data-testid="sales-date-from" className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700" />
          <input type="date" value={filters.dateTo} onChange={(event) => update("dateTo", event.target.value)} aria-label={t("returns.filterDateTo")} data-testid="sales-date-to" className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700" />
        </div>
        {hasFilters(filters) ? (
          <button type="button" onClick={() => setFilters(EMPTY_TRANSACTION_FILTERS)} className="text-xs font-bold text-indigo-700 hover:underline">
            {t("returns.clearSearch")}
          </button>
        ) : null}
      </Card>

      {error ? (
        <ErrorState title={t("common.error")} message={error} retryLabel={t("common.retry")} onRetry={() => setRefreshToken((value) => value + 1)} />
      ) : loading && !result ? (
        <div className="alyq-card"><LoadingBlock label={t("common.loading")} /></div>
      ) : !result || result.rows.length === 0 ? (
        <Card><EmptyState icon="🧾" title={t("pos.noTransactions")} description={t("pos.noTransactionsHint")} /></Card>
      ) : (
        <>
          <div className={`space-y-3 transition-opacity ${loading ? "opacity-60" : "opacity-100"}`} aria-busy={loading}>
            {result.rows.map((row) => (
              <TransactionCard key={row.id} row={row} busy={busyId === row.id} onConfirm={() => void confirmPayment(row.id)} />
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 alyq-card px-3 py-2.5 text-xs font-semibold text-slate-700">
            <span>{t("products.showing", { from: (result.page - 1) * result.page_size + 1, to: Math.min(result.page * result.page_size, result.total), total: result.total })}</span>
            <div className="flex items-center gap-2">
              <SelectInput value={String(filters.pageSize)} onChange={(event) => update("pageSize", Number(event.target.value))} className="h-8 w-auto py-1 text-xs">
                {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
              </SelectInput>
              <Button size="sm" variant="secondary" disabled={result.page <= 1} onClick={() => update("page", result.page - 1)}>‹ {t("products.prev")}</Button>
              <span>{result.page} / {Math.max(result.page_count, 1)}</span>
              <Button size="sm" variant="secondary" disabled={result.page >= result.page_count} onClick={() => update("page", result.page + 1)}>{t("products.next")} ›</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TransactionCard({ row, busy, onConfirm }: { row: TransactionCenterRow; busy: boolean; onConfirm: () => void }) {
  const { t, num, date } = useI18n();
  const awaitingPayment = row.status !== "voided" && row.payment_status === "pending";
  return (
    <article className="alyq-card p-4" data-testid={`transaction-${row.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/pos/sales/${row.id}`} className="font-mono text-sm font-black text-indigo-700 hover:underline">{row.sale_number}</Link>
            <SaleBadge status={row.status} />
            {row.source !== "pos" ? <Badge tone="info">{row.source}</Badge> : null}
          </div>
          <p className="mt-1 text-xs text-slate-500" dir="ltr">{date(row.created_at)}</p>
          <p className="mt-1 text-xs font-semibold text-slate-700">
            {row.customer_name || t("customers.guestCustomer")}
            {row.customer_phone ? <span className="ms-2 font-mono" dir="ltr">{row.customer_phone}</span> : null}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">{row.cashier_name}{row.branch_code ? ` · ${row.branch_code}` : ""}{row.shift_id ? ` · ${t("shifts.shiftNumber")} ${row.shift_id.slice(0, 8)}` : ""}</p>
        </div>
        <div className="text-end">
          <p className="text-lg font-black tabular-nums text-slate-900" dir="ltr">{num(row.total, 2)}</p>
          <p className="text-[11px] font-semibold text-slate-500">{row.item_count} · {row.payment_methods.map((method) => t(`pos.payment.${method}` as never)).join(" + ")}</p>
          <div className="mt-2 flex justify-end gap-2">
            {awaitingPayment && canConfirmPayment() ? <Button size="sm" variant="subtle" loading={busy} onClick={onConfirm}>✓ {t("pos.confirmPaymentShort")}</Button> : null}
            <Link to={`/pos/sales/${row.id}`} className="inline-flex h-8 items-center rounded-lg bg-slate-900 px-3 text-xs font-bold text-white">{t("common.view")}</Link>
          </div>
        </div>
      </div>

      {(row.returns.length > 0 || row.refunds.length > 0) ? (
        <div className="mt-3 border-t border-slate-100 pt-3" data-testid="transaction-linkage">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
            <span className="rounded-lg bg-indigo-50 px-2 py-1 text-indigo-800">SALE · {row.sale_number}</span>
            {row.returns.map((item) => (
              <span key={item.id} className="contents">
                <span className="text-slate-300">→</span>
                <Link to={`/returns/${item.id}`} className="rounded-lg bg-amber-50 px-2 py-1 text-amber-800 hover:underline">RETURN · {item.reference}</Link>
              </span>
            ))}
            {row.refunds.map((item) => (
              <span key={item.id} className="contents">
                <span className="text-slate-300">→</span>
                <span className={`rounded-lg px-2 py-1 ${item.status === "completed" ? "bg-emerald-50 text-emerald-800" : item.status === "pending" ? "bg-amber-50 text-amber-900" : "bg-rose-50 text-rose-800"}`}>
                  REFUND · {item.reference} · {t(`returns.status.${item.status}` as never)} · {num(item.amount, 2)}
                </span>
              </span>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] font-semibold">
            {row.completed_refund_total > 0 ? <span className="text-emerald-700">{t("pos.refundCompletedTotal")}: {num(row.completed_refund_total, 2)}</span> : null}
            {row.pending_refund_total > 0 ? <span className="text-amber-800">{t("pos.refundPendingTotal")}: {num(row.pending_refund_total, 2)}</span> : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function SaleBadge({ status }: { status: TransactionCenterRow["status"] }) {
  const { t } = useI18n();
  if (status === "completed") return <Badge tone="success">{t("pos.status.completed")}</Badge>;
  if (status === "pending") return <Badge tone="warning">{t("pos.status.pending")}</Badge>;
  return <Badge tone="danger">{t("pos.status.voided")}</Badge>;
}

function hasFilters(filters: TransactionCenterFilters): boolean {
  return Boolean(filters.query || filters.cashier || filters.dateFrom || filters.dateTo || filters.saleStatus !== "all" || filters.refundStatus !== "all" || filters.paymentMethod !== "all" || filters.paymentStatus !== "all");
}

function localDateInput(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
