import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingBlock,
  RotateCcwIcon,
  SectionTitle,
  StatTile,
  useToast,
} from "@/components/ui";
import { useReturns } from "../hooks/ReturnProvider";
import { useCustomers } from "@/modules/customers";
import { loadBrand } from "@/lib/branding/brand";
import {
  buildReturnReceiptHtml,
  customerInfoIssue,
  returnReceiptStrings,
  usePos,
} from "@/modules/pos";
import { printReceiptDocument } from "@/modules/pos/services/hardware";

export function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, date, num, isRTL } = useI18n();
  const { returnsList, refundsList, loading } = useReturns();
  const { sales } = usePos();
  const { customerById } = useCustomers();
  const toast = useToast();

  const returnRecord = useMemo(() => {
    return returnsList.find((r) => r.id === id);
  }, [returnsList, id]);

  const linkedRefund = useMemo(() => {
    if (!id) return undefined;
    return refundsList.find((ref) => ref.return_id === id);
  }, [refundsList, id]);

  // The return record does not store the phone; resolve it from the original
  // sale so the receipt can show it (works in demo and Supabase mode alike).
  const linkedSale = useMemo(() => {
    if (!returnRecord) return undefined;
    return sales.find((s) => s.id === returnRecord.sale_id);
  }, [sales, returnRecord]);

  /**
   * The return receipt inherits the customer from the original invoice. The
   * return record stores the name; the phone is resolved from the linked sale
   * first, then from the customer record as a fallback.
   */
  const linkedCustomer = useMemo(() => {
    if (!returnRecord?.customer_id) return undefined;
    return customerById(returnRecord.customer_id);
  }, [customerById, returnRecord]);

  const customerName = returnRecord?.customer_name ?? linkedCustomer?.name ?? null;
  const customerPhone = linkedSale?.customer_phone ?? linkedCustomer?.phone ?? null;

  /**
   * Print the return receipt through the shared receipt service + print
   * workflow (identical design and behaviour to the sales receipt).
   */
  const printReturnReceipt = async () => {
    if (!returnRecord) return;

    // A customer-linked return receipt must carry BOTH the customer name and
    // phone (inherited from the original invoice). Anonymous returns keep the
    // existing behaviour.
    const issue = customerInfoIssue(customerName, customerPhone);
    if (issue) {
      console.error("[receipt-print] abort: incomplete customer information", {
        return_number: returnRecord.return_number,
        issue,
        customer_name: customerName,
        customer_phone: customerPhone,
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
      html = buildReturnReceiptHtml({
        returnRecord: { ...returnRecord, customer_name: customerName },
        direction: isRTL ? "rtl" : "ltr",
        customerPhone,
        refundNumber: linkedRefund?.refund_number ?? null,
        strings: returnReceiptStrings(t, returnRecord.refund_status),
        logo_url: brand.receiptLogoEnabled ? brand.logoUrl : null,
      });
    } catch (err) {
      console.error("[receipt-print] failed to build return receipt html", {
        return_number: returnRecord.return_number,
        error: err instanceof Error ? err.message : err,
      });
      toast.error(t("pos.printFailed"));
      return;
    }

    const outcome = await printReceiptDocument(html, returnRecord.return_number);
    if (outcome === "submitted") toast.success(t("pos.printSubmitted"));
    else if (outcome === "native-failed") toast.error(t("pos.printFailed"));
    else if (outcome === "embedded-blocked") toast.error(t("pos.printEmbedded"));
    else if (outcome === "failed") toast.error(t("barcode.printBlocked"));
  };

  if (loading && !returnRecord) {
    return (
      <div className="alyq-card">
        <LoadingBlock label={t("common.loading")} />
      </div>
    );
  }

  if (!returnRecord) {
    return (
      <Card>
        <EmptyState
          icon="🔄"
          title={t("common.notFound")}
          description={t("returns.emptyHint")}
          action={
            <Link to="/returns" className="alyq-btn-primary alyq-cta h-10 rounded-xl px-4 text-sm">
              {t("returns.title")}
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div>
      <PageHeader
        title={returnRecord.return_number}
        subtitle={`${t("returns.returnDetails")} · ${date(returnRecord.created_at)}`}
        backTo="/returns"
        backLabel={t("returns.title")}
        actions={
          <>
            <Button variant="secondary" onClick={printReturnReceipt}>
              🖨 {t("returns.printReceipt")}
            </Button>
            <Link
              to={`/pos/sales/${returnRecord.sale_id}`}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              {t("returns.saleNumber")}: {returnRecord.sale_number}
            </Link>
          </>
        }
      />

      {/* KPI & Summary Tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        <StatTile
          label={t("returns.refundAmount")}
          value={num(returnRecord.refund_amount, 2)}
          tone="warning"
          icon={<RotateCcwIcon className="h-5 w-5 text-amber-500" />}
          hint={`${t("returns.refundMethod")}: ${t(`pos.payment.${returnRecord.refund_method}`)}`}
        />
        <StatTile
          label={t("returns.items")}
          value={String(returnRecord.items.reduce((s, i) => s + i.quantity, 0))}
          tone="primary"
          hint={`${returnRecord.items.length} ${t("pos.cols.items")}`}
        />
        <StatTile
          label={t("returns.customer")}
          value={returnRecord.customer_name || t("customers.guestCustomer")}
          tone="info"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Returned Items Table */}
        <Card>
          <SectionTitle>{t("returns.items")}</SectionTitle>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <th className="py-2 px-3 text-start">{t("pos.cols.items")}</th>
                  <th className="py-2 px-3 text-center">{t("returns.returnQty")}</th>
                  <th className="py-2 px-3 text-end">{t("pos.unit")}</th>
                  <th className="py-2 px-3 text-end">{t("returns.refundAmount")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {returnRecord.items.map((item) => (
                  <tr key={item.id}>
                    <td className="py-2.5 px-3">
                      <p className="font-semibold text-slate-900">
                        {isRTL ? item.name_ar || item.name_en : item.name_en || item.name_ar}
                      </p>
                      <p className="font-mono text-[10px] text-slate-500">{item.sku}</p>
                    </td>
                    <td className="py-2.5 px-3 text-center font-bold tabular-nums text-slate-900">
                      {item.quantity}
                    </td>
                    <td className="py-2.5 px-3 text-end tabular-nums text-xs text-slate-600 font-mono">
                      {num(item.unit_price, 2)}
                    </td>
                    <td className="py-2.5 px-3 text-end font-bold tabular-nums text-slate-900">
                      {num(item.line_total, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Audit Details */}
        <div className="space-y-4">
          <Card>
            <SectionTitle>{t("common.details")}</SectionTitle>
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">{t("returns.saleNumber")}</dt>
                <dd>
                  <Link
                    to={`/pos/sales/${returnRecord.sale_id}`}
                    className="font-mono font-bold text-indigo-700 hover:underline"
                  >
                    {returnRecord.sale_number}
                  </Link>
                </dd>
              </div>

              <div className="flex items-center justify-between">
                <dt className="text-slate-500">{t("returns.refundMethod")}</dt>
                <dd>
                  <Badge tone={returnRecord.refund_method === "cash" ? "success" : "info"}>
                    {t(`pos.payment.${returnRecord.refund_method}`)}
                  </Badge>
                </dd>
              </div>

              <div className="flex items-center justify-between">
                <dt className="text-slate-500">{t("pos.cols.user")}</dt>
                <dd className="font-semibold text-slate-900">{returnRecord.user_name}</dd>
              </div>

              <div className="flex items-center justify-between">
                <dt className="text-slate-500">{t("pos.cols.date")}</dt>
                <dd className="text-slate-700" dir="ltr">{date(returnRecord.created_at)}</dd>
              </div>

              <div className="border-t border-slate-100 pt-2">
                <dt className="font-semibold text-slate-700 mb-0.5">{t("returns.reason")}</dt>
                <dd className="rounded-lg bg-slate-50 p-2 text-slate-700">
                  {returnRecord.reason}
                </dd>
              </div>
            </dl>
          </Card>

          {/* Stock Movement Notice */}
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs space-y-1">
            <p className="font-bold text-emerald-900 flex items-center gap-1.5">
              <span>✓</span>
              <span>{t("returns.movementNotice")}</span>
            </p>
            <p className="text-emerald-700 leading-relaxed">
              {t("app.phase3")} · {t("nav.movements")}
            </p>
          </div>

          {/* Linked Refund Record Card */}
          {linkedRefund && (
            <Card>
              <SectionTitle>{t("returns.linkedRefund")}</SectionTitle>
              <dl className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t("refunds.refundNumber")}</dt>
                  <dd>
                    <Link
                      to={`/refunds/${linkedRefund.id}`}
                      className="font-mono font-bold text-indigo-700 hover:underline"
                    >
                      {linkedRefund.refund_number}
                    </Link>
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t("refunds.amount")}</dt>
                  <dd className="font-bold tabular-nums text-indigo-700">{num(linkedRefund.amount, 2)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t("refunds.status")}</dt>
                  <dd>
                    <Badge tone={linkedRefund.status === "completed" ? "success" : "warning"}>
                      {linkedRefund.status === "completed" ? t("refunds.paid") : t("refunds.pending")}
                    </Badge>
                  </dd>
                </div>
              </dl>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
