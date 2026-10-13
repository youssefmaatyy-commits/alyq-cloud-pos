import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { can } from "@/lib/permissions/enforce";
import { useBranch } from "@/lib/branch";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingBlock,
  SectionTitle,
  useToast,
} from "@/components/ui";
import { Link } from "react-router-dom";
import { usePos } from "../hooks/PosProvider";
import { canConfirmPayment } from "../permissions";
import type { Sale } from "../types";
import type { RefundRecord, SalesReturn } from "@/modules/returns/types";
import { buildReceiptHtml, customerInfoIssue } from "../services/receipt";
import { printReceiptDocument } from "../services/hardware";
import { salesReceiptStrings } from "../services/receiptStrings";
import { loadBrand } from "@/lib/branding/brand";
import { getSalesRepository } from "../data";
import { confirmPayment as confirmPaymentAction } from "../services/saleService";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { useReturns } from "@/modules/returns";
import { ReturnFormModal } from "@/modules/returns/components/ReturnFormModal";

/**
 * Sale detail — a receipt-style view with print, payment confirmation and sales
 * return actions. A completed sale is never cancelled here: completed-sale
 * cancellation is disabled (migration 0095); corrections are sales returns.
 */
export function SaleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, num, date, isRTL } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { sales, salesLoading, error, refreshSales } = usePos();
  const { branches } = useBranch();

  const [sale, setSale] = useState<Sale | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [saleReturns, setSaleReturns] = useState<SalesReturn[]>([]);
  const [saleRefunds, setSaleRefunds] = useState<RefundRecord[]>([]);
  const [confirmPay, setConfirmPay] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const { repository: returnRepository } = useReturns();
  const canViewSales = can("sales.view");

  useEffect(() => {
    let cancelled = false;
    if (!canViewSales) {
      setDetailLoading(false);
      return () => { cancelled = true; };
    }
    if (!id) {
      setSale(null);
      setDetailLoading(false);
      return () => { cancelled = true; };
    }
    const loaded = sales.find((item) => item.id === id) ?? null;
    setSale(loaded);
    setSaleReturns([]);
    setSaleRefunds([]);
    setDetailLoading(!loaded);
    setDetailError(null);
    void Promise.all([
      loaded ? Promise.resolve(loaded) : getSalesRepository().getSale(id),
      returnRepository.getReturnsForSale(id),
      returnRepository.getRefundsForSale(id),
    ]).then(([fullSale, returns, refunds]) => {
      if (cancelled) return;
      setSale(fullSale);
      setSaleReturns(returns);
      setSaleRefunds(refunds);
    }).catch((cause) => {
      if (!cancelled) setDetailError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setDetailLoading(false);
    });
    return () => { cancelled = true; };
  }, [canViewSales, detailRefreshToken, sales, id, returnRepository]);

  /**
   * Reprint the sales receipt from a completed transaction. Uses the shared
   * print workflow so a reprint behaves exactly like the receipt printed at
   * the till (popup, then hidden in-page frame fallback).
   */
  const print = useCallback(async () => {
    if (!sale) return;

    // Customer-linked receipts must carry BOTH the customer name and phone.
    // Anonymous/guest sales keep their existing behaviour.
    const issue = customerInfoIssue(sale.customer_name, sale.customer_phone);
    if (issue) {
      console.error("[receipt-print] abort: incomplete customer information", {
        sale_number: sale.sale_number,
        issue,
      });
      toast.error(
        t(issue === "missingName" ? "receipt.customerNameMissing" : "receipt.customerPhoneMissing"),
      );
      return;
    }

    toast.success(t("pos.printing"));

    let html: string;
    try {
      // Phase 46: the shared brand logo when enabled; shipped asset otherwise.
      const brand = await loadBrand();
      html = buildReceiptHtml({
        sale,
        direction: isRTL ? "rtl" : "ltr",
        strings: salesReceiptStrings(t),
        logo_url: brand.receiptLogoEnabled ? brand.logoUrl : null,
      });
    } catch (err) {
      console.error("[receipt-print] failed to build receipt html", {
        sale_number: sale.sale_number,
        error: err instanceof Error ? err.message : err,
      });
      toast.error(t("pos.printFailed"));
      return;
    }

    const outcome = await printReceiptDocument(html, sale.sale_number);
    if (outcome === "submitted") toast.success(t("pos.printSubmitted"));
    else if (outcome === "native-failed") toast.error(t("pos.printFailed"));
    else if (outcome === "embedded-blocked") toast.error(t("pos.printEmbedded"));
    else if (outcome === "failed") toast.error(t("barcode.printBlocked"));
  }, [sale, isRTL, t, toast]);


  const confirmPayment = useCallback(async () => {
    if (!sale) return;
    setConfirming(true);
    try {
      const user = getCurrentUser();
      const repo = getSalesRepository();
      await confirmPaymentAction(sale.id, { user_id: user.id, user_name: user.name });
      toast.success(t("pos.paymentConfirmed"));
      setConfirmPay(false);
      await refreshSales();
      const updated = (await repo.listSales()).find((s) => s.id === sale.id) ?? null;
      setSale(updated);
    } catch {
      toast.error(t("pos.paymentConfirmFailed"));
    } finally {
      setConfirming(false);
    }
  }, [sale, t, toast, refreshSales]);

  if (!canViewSales) {
    return (
      <EmptyState
        icon="🔒"
        title={t("perm.denied")}
        description={t("permissions.denied.view_sales")}
      />
    );
  }

  if ((salesLoading || detailLoading) && !sale) {
    return (
      <div className="alyq-card">
        <LoadingBlock label={t("common.loading")} />
      </div>
    );
  }

  if ((error || detailError) && !sale) {
    return (
      <ErrorState
        title={t("products.errorLoad")}
        message={detailError ?? error?.message ?? t("common.error")}
        retryLabel={t("common.retry")}
        onRetry={() => {
          setDetailRefreshToken((value) => value + 1);
          void refreshSales();
        }}
      />
    );
  }

  if (!sale) {
    return (
      <Card>
        <EmptyState
          icon="🧾"
          title={t("common.notFound")}
          description={t("pos.salesSubtitle")}
          action={
            <Button variant="secondary" onClick={() => navigate("/pos/sales")}>
              {t("pos.salesTitle")}
            </Button>
          }
        />
      </Card>
    );
  }

  // Authorized action: any still-pending InstaPay payment can be confirmed.
  const awaitingInstaPay =
    sale.status !== "voided" &&
    sale.payments.some((p) => p.method === "instapay" && p.status === "pending");
  const canConfirm = canConfirmPayment() && awaitingInstaPay;
  const canReturn = can("returns.process");
  const canViewCustomers = can("customers.view");

  return (
    <div>
      <PageHeader
        title={t("pos.receiptTitle")}
        crumbs={[{ label: t("home.management.title"), to: "/management" }, { label: t("nav.sales"), to: "/pos/sales" }, { label: sale.sale_number }]}
        subtitle={sale.sale_number}
        backTo="/pos/sales"
        backLabel={t("pos.salesTitle")}
        actions={
          <>
            {canConfirm ? (
              <Button onClick={() => setConfirmPay(true)}>
                ✓ {t("pos.confirmPayment")}
              </Button>
            ) : null}
            {canReturn && sale.status !== "voided" ? (
              <Button variant="secondary" onClick={() => setReturnOpen(true)}>
                ↩ {t("returns.newReturn")}
              </Button>
            ) : null}
            <Button onClick={() => void print()}>🖨 {t("pos.printReceipt")}</Button>
          </>
        }
      />

      {canViewCustomers && (sale.customer_id || sale.customer_name) ? (
        <Link
          to={sale.customer_id ? `/customers/${sale.customer_id}` : "/customers"}
          className="alyq-card mb-4 flex items-center justify-between gap-3 p-4 transition hover:border-indigo-300"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-lg">
              👤
            </span>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                {t("customers.customerLabel")}
              </p>
              <p className="text-sm font-bold text-slate-900">{sale.customer_name ?? "—"}</p>
              {sale.customer_phone ? (
                <p className="font-mono text-xs text-slate-600" dir="ltr">
                  {sale.customer_phone}
                </p>
              ) : null}
            </div>
          </div>
          <span className="text-xs font-bold text-indigo-600">→</span>
        </Link>
      ) : null}

      {sale.notes ? (
        <Card className="mb-4" data-testid="sale-note">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{t("pos.saleNote")}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{sale.notes}</p>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <SectionTitle>{t("pos.cols.items")}</SectionTitle>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <th className="py-2 text-start font-semibold">{t("receipt.itemLabel")}</th>
                <th className="py-2 text-center font-semibold">{t("receipt.qtyLabel")}</th>
                <th className="py-2 text-end font-semibold">{t("receipt.priceLabel")}</th>
                <th className="py-2 text-end font-semibold">{t("receipt.totalLabel")}</th>
              </tr>
            </thead>
            <tbody>
              {sale.items.map((item) => (
                <tr key={item.id} className="border-b border-slate-50 last:border-0">
                  <td className="py-2.5">
                    <p className="text-xs font-semibold text-slate-900">
                      {isRTL ? item.name_ar || item.name_en : item.name_en || item.name_ar}
                    </p>
                    <p className="font-mono text-[10px] text-slate-500">{item.sku}</p>
                    {item.variant_id ? (
                      <p className="text-[10px] font-semibold text-slate-600" data-testid="sale-item-variant">
                        {[isRTL ? item.variant_color_ar || item.variant_color_en : item.variant_color_en || item.variant_color_ar, item.variant_size_label || item.variant_size].filter(Boolean).join(" / ")}
                      </p>
                    ) : null}
                    {item.automatic_promotion_name ? (
                      <p className="mt-0.5 text-[10px] font-semibold text-emerald-700">
                        🏷 {item.automatic_promotion_name} · −{num(item.automatic_discount_amount ?? 0, 2)}
                      </p>
                    ) : null}
                  </td>
                  <td className="py-2.5 text-center text-sm font-bold tabular-nums">{item.quantity}</td>
                  <td className="py-2.5 text-end text-xs tabular-nums text-slate-600">
                    {num(item.unit_price, 2)}
                    {item.discount_amount ? <span className="block text-[10px] text-rose-600">−{num(item.discount_amount, 2)} item</span> : null}
                  </td>
                  <td className="py-2.5 text-end text-sm font-bold tabular-nums text-slate-900">
                    {num(item.line_total, 2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="space-y-4">
          <Card>
            <SectionTitle>{t("pos.total")}</SectionTitle>
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between text-slate-600">
                <dt>{t("pos.subtotal")}</dt>
                <dd className="tabular-nums">{num(sale.subtotal, 2)}</dd>
              </div>
              <div className="flex justify-between text-slate-600">
                <dt>Item discounts / خصم الأصناف</dt>
                <dd className="tabular-nums text-rose-600">−{num(sale.item_discount_amount ?? 0, 2)}</dd>
              </div>
              {(sale.automatic_discount_amount ?? 0) > 0 ? (
                <div className="flex justify-between text-emerald-700">
                  <dt>🏷 {sale.automatic_promotion_name ?? t("online.promos.title")}</dt>
                  <dd className="tabular-nums">−{num(sale.automatic_discount_amount ?? 0, 2)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between text-slate-600">
                <dt>Invoice discount / خصم الفاتورة</dt>
                <dd className="tabular-nums text-rose-600">−{num(sale.discount_amount, 2)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-extrabold text-slate-900">
                <dt>{t("pos.total")}</dt>
                <dd className="tabular-nums">{num(sale.total, 2)}</dd>
              </div>
            </dl>
          </Card>

          <Card>
            <SectionTitle>{t("pos.paymentsBreakdown")}</SectionTitle>
            <ul className="space-y-2">
              {sale.payments.map((payment) => (
                <li
                  key={payment.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-2 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <Badge tone={payment.method === "cash" ? "success" : "info"}>
                      {t(`pos.payment.${payment.method}`)}
                    </Badge>
                    {payment.method === "instapay" ? (
                      <Badge tone={payment.status === "paid" ? "success" : "warning"}>
                        {payment.status === "paid" ? t("pos.instapay.paid") : t("pos.instapay.pending")}
                      </Badge>
                    ) : null}
                  </div>
                  <span className="text-sm font-bold tabular-nums text-slate-900">
                    {num(payment.amount, 2)}
                  </span>
                </li>
              ))}
            </ul>

            {sale.amount_received != null ? (
              <dl className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-sm">
                <div className="flex justify-between text-slate-600">
                  <dt>{t("receipt.receivedLabel")}</dt>
                  <dd className="tabular-nums">{num(sale.amount_received, 2)}</dd>
                </div>
                <div className="flex justify-between text-slate-600">
                  <dt>{t("receipt.changeLabel")}</dt>
                  <dd className="tabular-nums">{num(sale.change ?? 0, 2)}</dd>
                </div>
              </dl>
            ) : null}

            {sale.payment_status === "paid" && sale.paid_at ? (
              <div className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-600">
                <p>
                  {t("pos.paidAtLabel")}: <span dir="ltr">{date(sale.paid_at)}</span>
                </p>
                <p className="mt-0.5">
                  {t("pos.paidByLabel")}:{" "}
                  <span className="font-semibold text-slate-900">{sale.paid_by_name ?? "—"}</span>
                </p>
              </div>
            ) : null}

            {canConfirm ? (
              <Button className="mt-3 w-full" size="sm" loading={confirming} onClick={() => setConfirmPay(true)}>
                ✓ {t("pos.confirmPayment")}
              </Button>
            ) : null}
          </Card>

          <Card>
            <SectionTitle>{t("pos.cols.date")}</SectionTitle>
            <p className="text-xs text-slate-600" dir="ltr">
              {date(sale.created_at)}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {t("pos.cols.user")}: <span className="font-semibold text-slate-900">{sale.user_name}</span>
            </p>
            <p className="mt-1 break-all text-xs text-slate-600">
              {t("pos.clientReference")}: <span className="font-mono text-[11px] text-slate-900">{sale.client_ref}</span>
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {t("pos.saleSource")}: <span className="font-semibold text-slate-900">{sale.source ?? "pos"}</span>
            </p>
            {sale.branch_id ? (
              <p className="mt-1 text-xs text-slate-600">
                {isRTL ? "الفرع" : "Branch"}:{" "}
                <span className="font-semibold text-slate-900">
                  {(() => {
                    const branch = branches.find((entry) => entry.id === sale.branch_id);
                    return branch ? (isRTL ? branch.name_ar : branch.name_en) : sale.branch_id;
                  })()}
                </span>
              </p>
            ) : null}
            {sale.shift_id ? (
              <p className="mt-1 break-all text-xs text-slate-600">
                {t("shifts.shiftNumber")}: <span className="font-mono text-[11px] text-slate-900">{sale.shift_id}</span>
              </p>
            ) : null}
            <p className="mt-1 text-xs text-slate-600">
              {t("customers.customerLabel")}:{" "}
              {sale.customer_id ? (
                <Link to={`/customers/${sale.customer_id}`} className="font-semibold text-indigo-700 hover:underline">
                  {sale.customer_name ?? "—"}
                </Link>
              ) : (
                <span className="font-medium text-slate-500">{t("customers.guestCustomer")}</span>
              )}
            </p>
            {sale.status === "voided" ? (
              <div className="mt-2 rounded-lg bg-rose-50 p-2 text-[11px] font-semibold text-rose-700">
                {t("receipt.voidedNotice")}
                {sale.voided_at ? (
                  <span className="ms-2 font-normal" dir="ltr">
                    {date(sale.voided_at)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </Card>

          {(saleReturns.length > 0 || saleRefunds.length > 0) && (
            <Card>
              <SectionTitle>{t("returns.title")}</SectionTitle>
              <div className="space-y-2">
                {saleReturns.map((ret) => (
                  <Link
                    key={ret.id}
                    to={`/returns/${ret.id}`}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2 transition hover:border-indigo-200 hover:bg-indigo-50/40"
                  >
                    <div>
                      <p className="font-mono text-xs font-bold text-indigo-700">{ret.return_number}</p>
                      <p className="text-[11px] text-slate-500" dir="ltr">{date(ret.created_at)}</p>
                    </div>
                    <span className="text-end text-xs font-bold tabular-nums text-slate-900">
                      {num(ret.refund_amount, 2)}
                      {saleRefunds.find((refund) => refund.return_id === ret.id) ? (
                        <span className={`mt-0.5 block text-[10px] ${saleRefunds.find((refund) => refund.return_id === ret.id)?.status === "completed" ? "text-emerald-700" : saleRefunds.find((refund) => refund.return_id === ret.id)?.status === "pending" ? "text-amber-700" : "text-rose-700"}`}>
                          {t(`returns.status.${saleRefunds.find((refund) => refund.return_id === ret.id)!.status}` as never)}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                ))}
                {saleRefunds.filter((r) => !r.return_id).map((ref) => (
                  <div
                    key={ref.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2"
                  >
                    <div>
                      <p className="font-mono text-xs font-bold text-slate-900">{ref.refund_number}</p>
                      <p className="text-[11px] text-slate-500" dir="ltr">{date(ref.created_at)}</p>
                    </div>
                    <span className="text-xs font-bold tabular-nums text-slate-900">
                      {num(ref.amount, 2)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {returnOpen && (
        <ReturnFormModal
          open={returnOpen}
          onClose={() => setReturnOpen(false)}
          preselectedSaleId={sale.id}
          preselectedSale={sale}
          preselectedReturns={saleReturns}
          preselectedRefunds={saleRefunds}
          onSuccess={() => {
            void Promise.all([
              returnRepository.getReturnsForSale(sale.id),
              returnRepository.getRefundsForSale(sale.id),
            ]).then(([returns, refunds]) => {
              setSaleReturns(returns);
              setSaleRefunds(refunds);
            });
          }}
        />
      )}

      <ConfirmDialog
        open={confirmPay}
        onCancel={() => setConfirmPay(false)}
        onConfirm={() => void confirmPayment()}
        title={t("pos.confirmPaymentTitle")}
        body={t("pos.confirmPaymentBody", { sale: sale.sale_number })}
        confirmLabel={t("pos.confirmPaymentShort")}
        tone="primary"
        loading={confirming}
      />
    </div>
  );
}
