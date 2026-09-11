import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EditIcon,
  EmptyState,
  EyeIcon,
  LoadingBlock,
  SectionTitle,
  StatTile,
  UsersIcon,
} from "@/components/ui";
import { useCustomers } from "../hooks/CustomerProvider";
import { CustomerFormModal } from "../components/CustomerFormModal";
import { usePos } from "@/modules/pos";
import { useReturns } from "@/modules/returns";

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, date, num } = useI18n();
  const { customers, loading } = useCustomers();
  const { sales } = usePos();
  const { returnsList } = useReturns();

  const [modalOpen, setModalOpen] = useState(false);

  const customer = useMemo(() => {
    return customers.find((c) => c.id === id);
  }, [customers, id]);

  const customerSales = useMemo(() => {
    if (!id) return [];
    return sales.filter((s) => s.customer_id === id);
  }, [sales, id]);

  const customerReturns = useMemo(() => {
    if (!id) return [];
    return returnsList.filter((r) => r.customer_id === id);
  }, [returnsList, id]);

  const stats = useMemo(() => {
    let totalSpent = 0;
    let completedCount = 0;
    for (const s of customerSales) {
      if (s.status !== "voided") {
        totalSpent += s.total;
        completedCount++;
      }
    }
    return {
      totalPurchases: customerSales.length,
      completedCount,
      totalSpent,
    };
  }, [customerSales]);

  if (loading && !customer) {
    return (
      <div className="alyq-card">
        <LoadingBlock label={t("common.loading")} />
      </div>
    );
  }

  if (!customer) {
    return (
      <Card>
        <EmptyState
          icon="👥"
          title={t("common.notFound")}
          description={t("customers.emptyHint")}
          action={
            <Link to="/customers" className="alyq-btn-primary alyq-cta h-10 rounded-xl px-4 text-sm">
              {t("customers.title")}
            </Link>
          }
        />
      </Card>
    );
  }

  const statusBadge = (status: string) => {
    if (status === "completed") return <Badge tone="success">{t("pos.status.completed")}</Badge>;
    if (status === "pending") return <Badge tone="warning">{t("pos.status.pending")}</Badge>;
    return <Badge tone="danger">{t("pos.status.voided")}</Badge>;
  };

  return (
    <div>
      <PageHeader
        title={customer.name}
        subtitle={`${t("customers.details")} · ${customer.phone}`}
        backTo="/customers"
        backLabel={t("customers.title")}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => setModalOpen(true)}
              className="gap-1.5"
            >
              <EditIcon />
              {t("common.edit")}
            </Button>
            <Link
              to="/pos"
              className="alyq-btn-primary alyq-cta h-10 gap-2 rounded-xl px-4 text-sm"
            >
              {t("nav.register")}
            </Link>
          </>
        }
      />

      {/* Customer Info Card & Stats */}
      <div className="grid gap-4 lg:grid-cols-[1fr_360px] mb-6">
        <Card>
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
              <UsersIcon className="h-7 w-7" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <h2 className="text-lg font-bold text-slate-900">{customer.name}</h2>
              <p className="font-mono text-sm font-semibold text-slate-700" dir="ltr">
                {customer.phone}
              </p>
              {customer.address ? (
                <p className="text-xs text-slate-600">{customer.address}</p>
              ) : (
                <p className="text-xs text-slate-400">—</p>
              )}
              {customer.notes && (
                <div className="mt-2 rounded-xl bg-slate-50 p-2.5 text-xs text-slate-600">
                  <span className="font-semibold text-slate-700">{t("customers.notes")}: </span>
                  {customer.notes}
                </div>
              )}
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-3">
          <StatTile
            label={t("customers.totalSales")}
            value={String(stats.totalPurchases)}
            tone="primary"
          />
          <StatTile
            label={t("customers.totalSpent")}
            value={num(stats.totalSpent, 2)}
            tone="success"
          />
        </div>
      </div>

      {/* Returns History */}
      {customerReturns.length > 0 ? (
        <Card className="mb-6">
          <div className="mb-4 flex items-center justify-between">
            <SectionTitle>{t("customers.returnsHistory")}</SectionTitle>
            <span className="text-xs font-semibold text-slate-500">
              {customerReturns.length} {t("common.results")}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                  <th className="px-4 py-3 text-start font-semibold">{t("returns.returnNumber")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("returns.saleNumber")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("returns.refundAmount")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.date")}</th>
                  <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {customerReturns.map((ret) => (
                  <tr
                    key={ret.id}
                    className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/returns/${ret.id}`}
                        className="font-mono text-xs font-bold text-indigo-700 hover:underline"
                      >
                        {ret.return_number}
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <Link
                        to={`/pos/sales/${ret.sale_id}`}
                        className="font-mono text-xs font-semibold text-slate-700 hover:text-indigo-600 hover:underline"
                      >
                        {ret.sale_number}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-slate-900">
                      {num(ret.refund_amount, 2)}
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500" dir="ltr">
                      {date(ret.created_at)}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Link
                        to={`/returns/${ret.id}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
                        title={t("common.view")}
                      >
                        <EyeIcon />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* Purchase History */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <SectionTitle>{t("customers.purchaseHistory")}</SectionTitle>
          <span className="text-xs font-semibold text-slate-500">
            {customerSales.length} {t("common.results")}
          </span>
        </div>

        {customerSales.length === 0 ? (
          <EmptyState
            icon="🧾"
            title={t("customers.noPurchases")}
            description={t("pos.scanHint")}
            action={
              <Link to="/pos" className="alyq-btn-primary alyq-cta h-10 rounded-xl px-4 text-sm">
                {t("nav.register")}
              </Link>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                  <th className="px-4 py-3 text-start font-semibold">{t("pos.cols.saleNumber")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.date")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.items")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("pos.cols.total")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.method")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.status")}</th>
                  <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {customerSales.map((sale) => (
                  <tr
                    key={sale.id}
                    className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 transition-colors"
                  >
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
                    <td className="px-3 py-3 text-xs text-slate-700">
                      {sale.items.length} {t("pos.cols.items")}
                    </td>
                    <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-slate-900">
                      {num(sale.total, 2)}
                    </td>
                    <td className="px-3 py-3 text-xs font-semibold text-slate-700">
                      {t(`pos.payment.${sale.payment_method}`)}
                    </td>
                    <td className="px-3 py-3">{statusBadge(sale.status)}</td>
                    <td className="px-4 py-3 text-end">
                      <Link
                        to={`/pos/sales/${sale.id}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
                        title={t("common.view")}
                      >
                        <EyeIcon />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Edit Modal */}
      {modalOpen && (
        <CustomerFormModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          customer={customer}
        />
      )}
    </div>
  );
}
