import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
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
import { canVoidSale, canConfirmPayment } from "../permissions";
import type { Sale } from "../types";
import { buildReceiptHtml, customerInfoIssue, printHtmlDocument } from "../services/receipt";
import { salesReceiptStrings } from "../services/receiptStrings";
import { getSalesRepository } from "../data";
import {
  confirmPayment as confirmPaymentAction,
  voidSale as voidSaleAction,
} from "../services/saleService";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { useReturns } from "@/modules/returns";
import { ReturnFormModal } from "@/modules/returns/components/ReturnFormModal";

/**
 * Sale detail — a receipt-style view with a print action and (for managers)
 * a void action that returns stock to inventory.
 */
export function SaleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, num, date, isRTL } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { sales, salesLoading, error, refreshSales } = usePos();

  const [sale, setSale] = useState<Sale | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [confirmPay, setConfirmPay] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const { getReturnsForSale, getRefundsForSale } = useReturns();
  const saleReturns = sale ? getReturnsForSale(sale.id) : [];
  const saleRefunds = sale ? getRefundsForSale(sale.id) : [];

  useEffect(() => {
    const found = sales.find((s) => s.id === id) ?? null;
    setSale(found);
  }, [sales, id]);

  /**
   * Reprint the sales receipt from a completed transaction. Uses the shared
   * print workflow so a reprint behaves exactly like the receipt printed at
   * the till (popup, then hidden in-page frame fallback).
   */
  const print = useCallback(() => {
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
      html = buildReceiptHtml({
        sale,
        direction: isRTL ? "rtl" : "ltr",
        strings: salesReceiptStrings(t),
      });
    } catch (err) {
      console.error("[receipt-print] failed to build receipt html", {
        sale_number: sale.sale_number,
        error: err instanceof Error ? err.message : err,
      });
      toast.error(t("pos.printFailed"));
      return;
    }

    const outcome = printHtmlDocument(html, sale.sale_number);
    if (outcome === "embedded-blocked") {
      toast.error(t("pos.printEmbedded"));
    } else if (outcome === "failed") {
      toast.error(t("barcode.printBlocked"));
    }
  }, [sale, isRTL, t, toast]);

  const voidSale = useCallback(async () => {
    if (!sale) return;
    setVoiding(true);
    try {
      const user = getCurrentUser();
      const repo = getSalesRepository();
      // The service asserts `void_sale`; the page only decides whether to show
      // the button. A denial arrives as AppError("FORBIDDEN") and is reported
      // like any other failure to void.
      await voidSaleAction(sale.id, {
        user_id: user.id,
        user_name: user.name,
        reason: null,
      });
      toast.success(t("pos.voided"));
      setConfirmVoid(false);
      await refreshSales();
      const updated = (await repo.listSales()).find((s) => s.id === sale.id) ?? null;
      setSale(updated);
    } catch {
      toast.error(t("pos.saleFailed"));
    } finally {
      setVoiding(false);
    }
  }, [sale, t, toast, refreshSales]);

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

  if (salesLoading && !sale) {
    return (
      <div className="alyq-card">
        <LoadingBlock label={t("common.loading")} />
      </div>
    );
  }

  if (error && !sale) {
    return (
      <ErrorState
        title={t("products.errorLoad")}
        message={error.message}
        retryLabel={t("common.retry")}
        onRetry={() => void refreshSales()}
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

  const canVoid = canVoidSale() && sale.status !== "voided";
  // Authorized action: any still-pending InstaPay payment can be confirmed.
  const awaitingInstaPay =
    sale.status !== "voided" &&
    sale.payments.some((p) => p.method === "instapay" && p.status === "pending");
  const canConfirm = canConfirmPayment() && awaitingInstaPay;

  return (
    <div>
      <PageHeader
        title={t("pos.receiptTitle")}
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
            {sale.status !== "voided" ? (
              <Button variant="secondary" onClick={() => setReturnOpen(true)}>
                ↩ {t("returns.newReturn")}
              </Button>
            ) : null}
            {canVoid ? (
              <Button variant="danger" onClick={() => setConfirmVoid(true)}>
                {t("pos.void")}
              </Button>
            ) : null}
            <Button onClick={() => void print()}>🖨 {t("pos.printReceipt")}</Button>
          </>
        }
      />

      {sale.customer_id || sale.customer_name ? (
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
                  </td>
                  <td className="py-2.5 text-center text-sm font-bold tabular-nums">{item.quantity}</td>
                  <td className="py-2.5 text-end text-xs tabular-nums text-slate-600">
                    {num(item.unit_price, 2)}
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
                <dt>{t("pos.discount")}</dt>
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
                    <span className="text-xs font-bold tabular-nums text-slate-900">
                      {num(ret.refund_amount, 2)}
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
        />
      )}

      <ConfirmDialog
        open={confirmVoid}
        onCancel={() => setConfirmVoid(false)}
        onConfirm={() => void voidSale()}
        title={t("pos.void")}
        body={t("pos.voidConfirm")}
        confirmLabel={t("pos.void")}
        tone="danger"
        loading={voiding}
      />

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
