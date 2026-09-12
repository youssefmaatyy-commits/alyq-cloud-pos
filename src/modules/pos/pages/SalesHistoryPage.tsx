import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
import { buildSalesSheets } from "../services/salesExport";
import { normalizeText } from "@/modules/products/services/productQuery";
import { canConfirmPayment } from "../permissions";
import { getSalesRepository } from "../data";
import { getCurrentUser } from "@/modules/inventory/permissions";

/**
 * Sales history — every completed / pending / voided sale.
 * Read-only; voiding happens from the sale detail screen.
 */
export function SalesHistoryPage() {
  const { t, pick, date, num } = useI18n();
  const toast = useToast();
  const { sales, salesLoading, error, refreshSales } = usePos();
  const allowConfirm = canConfirmPayment();

  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Authorized inline confirmation from history — no totals/stock change. */
  const confirmPayment = async (saleId: string) => {
    setBusyId(saleId);
    try {
      const user = getCurrentUser();
      await getSalesRepository().confirmPayment(saleId, {
        user_id: user.id,
        user_name: user.name,
      });
      toast.success(t("pos.paymentConfirmed"));
      await refreshSales();
    } catch {
      toast.error(t("pos.paymentConfirmFailed"));
    } finally {
      setBusyId(null);
    }
  };
  const [status, setStatus] = useState<"all" | "completed" | "pending" | "voided">("all");
  const [method, setMethod] = useState<"all" | "cash" | "instapay">("all");

  const filtered = useMemo(() => {
    const needle = normalizeText(search);
    const terms = needle ? needle.split(" ") : [];
    return sales.filter((sale) => {
      if (status !== "all" && sale.status !== status) return false;
      if (method !== "all" && sale.payment_method !== method) return false;
      if (terms.length > 0) {
        const haystack = normalizeText(
          [
            sale.sale_number,
            sale.user_name,
            sale.items
              .map((i) => `${i.name_en} ${i.name_ar} ${i.sku}`)
              .join(" "),
          ].join(" \u0001 "),
        );
        for (const term of terms) {
          if (!haystack.includes(term)) return false;
        }
      }
      return true;
    });
  }, [sales, search, status, method]);

  const statusBadge = (status: string) => {
    if (status === "completed") return <Badge tone="success">{t("pos.status.completed")}</Badge>;
    if (status === "pending") return <Badge tone="warning">{t("pos.status.pending")}</Badge>;
    return <Badge tone="danger">{t("pos.status.voided")}</Badge>;
  };

  // A pending InstaPay sale the current user is allowed to confirm.
  const canConfirmSale = (sale: (typeof sales)[number]) =>
    allowConfirm &&
    sale.status !== "voided" &&
    sale.payments.some((p) => p.method === "instapay" && p.status === "pending");

  // Compact method summary: "Cash", "InstaPay" or "Cash + InstaPay".
  const methodsLabel = (sale: (typeof sales)[number]) => {
    const methods = [...new Set((sale.payments ?? []).map((p) => p.method))];
    if (methods.length === 0) return sale.payment_method === "cash" ? t("pos.payment.cash") : t("pos.payment.instapay");
    return methods.map((m) => t(`pos.payment.${m}`)).join(" + ");
  };

  const confirmButton = (sale: (typeof sales)[number]) =>
    canConfirmSale(sale) ? (
      <Button
        size="sm"
        variant="subtle"
        className="whitespace-nowrap"
        loading={busyId === sale.id}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void confirmPayment(sale.id);
        }}
      >
        ✓ {t("pos.confirmPaymentShort")}
      </Button>
    ) : null;

  return (
    <div>
      <PageHeader
        title={t("pos.salesTitle")}
        subtitle={t("pos.salesSubtitle")}
        actions={
          <>
            {/* Exports `filtered` — search + status + method all applied. */}
            <ExportButton
              name="sales"
              count={filtered.length}
              build={() => buildSalesSheets({ sales: filtered, t, pick })}
            />
            <Link
              to="/pos"
              className="alyq-btn-primary alyq-cta h-10 gap-2 rounded-xl px-4 text-sm"
            >
              {t("nav.register")}
            </Link>
          </>
        }
      />

      <Card className="mb-4 grid gap-3 sm:grid-cols-3">
        <TextInput
          value={search}
          leading={<SearchIcon />}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("pos.cols.saleNumber") + " / " + t("pos.cols.user")}
          aria-label={t("common.search")}
          type="search"
        />
        <SelectInput
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          aria-label={t("pos.cols.status")}
        >
          <option value="all">{`${t("pos.cols.status")}: ${t("common.all")}`}</option>
          <option value="completed">{t("pos.status.completed")}</option>
          <option value="pending">{t("pos.status.pending")}</option>
          <option value="voided">{t("pos.status.voided")}</option>
        </SelectInput>
        <SelectInput
          value={method}
          onChange={(e) => setMethod(e.target.value as typeof method)}
          aria-label={t("pos.cols.method")}
        >
          <option value="all">{`${t("pos.cols.method")}: ${t("common.all")}`}</option>
          <option value="cash">{t("pos.payment.cash")}</option>
          <option value="instapay">{t("pos.payment.instapay")}</option>
        </SelectInput>
      </Card>

      {error ? (
        <ErrorState
          title={t("products.errorLoad")}
          message={error.message}
          retryLabel={t("common.retry")}
          onRetry={() => void refreshSales()}
        />
      ) : salesLoading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon="🧾"
            title={t("pos.emptyCart")}
            description={t("pos.salesSubtitle")}
            action={
              <Link to="/pos" className="alyq-btn-primary alyq-cta h-10 rounded-xl px-4 text-sm">
                {t("nav.register")}
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="alyq-card hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                  <th className="px-4 py-3 text-start font-semibold">{t("pos.cols.saleNumber")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.date")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.items")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("pos.cols.total")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.method")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.user")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.status")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((sale) => (
                  <tr key={sale.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <Link
                        to={`/pos/sales/${sale.id}`}
                        className="font-mono text-xs font-bold text-indigo-700 hover:underline"
                      >
                        {sale.sale_number}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-600" dir="ltr">
                      {date(sale.created_at)}
                    </td>
                    <td className="px-3 py-3 text-xs font-semibold text-slate-700">
                      {sale.items.length}
                    </td>
                    <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-slate-900">
                      {num(sale.total, 2)}
                    </td>
                    <td className="px-3 py-3 text-xs font-semibold text-slate-700">
                      {methodsLabel(sale)}
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-600">{sale.user_name}</td>
                    <td className="px-3 py-3">{statusBadge(sale.status)}</td>
                    <td className="px-3 py-3 text-end">{confirmButton(sale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 md:hidden">
            {filtered.map((sale) => (
              <Link
                key={sale.id}
                to={`/pos/sales/${sale.id}`}
                className="alyq-card block p-3 transition hover:border-indigo-300"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-bold text-indigo-700">{sale.sale_number}</p>
                    <p className="text-[11px] text-slate-500" dir="ltr">{date(sale.created_at)}</p>
                  </div>
                  {statusBadge(sale.status)}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-700">
                    {sale.items.length} · {t(`pos.payment.${sale.payment_method}`)}
                  </span>
                  <span className="text-sm font-extrabold tabular-nums text-slate-900">
                    {num(sale.total, 2)}
                  </span>
                </div>
                {confirmButton(sale) ? (
                  <div className="mt-2 flex justify-end" onClick={(event) => event.preventDefault()}>
                    {confirmButton(sale)}
                  </div>
                ) : null}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
