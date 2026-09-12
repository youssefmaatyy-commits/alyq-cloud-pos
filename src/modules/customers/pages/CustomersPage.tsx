import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  ConfirmDialog,
  EditIcon,
  EmptyState,
  ErrorState,
  ExportButton,
  EyeIcon,
  LoadingBlock,
  PlusIcon,
  SearchIcon,
  StatTile,
  TextInput,
  TrashIcon,
  UsersIcon,
  useToast,
} from "@/components/ui";
import { buildCustomersSheets } from "../services/customersExport";
import { useCustomers } from "../hooks/CustomerProvider";
import { queryCustomers } from "../services/customerService";
import { CustomerFormModal } from "../components/CustomerFormModal";
import type { Customer } from "../types";
import { usePos } from "@/modules/pos";

export function CustomersPage() {
  const { t, date, num } = useI18n();
  const toast = useToast();
  const { customers, loading, error, refresh, deleteCustomer } = useCustomers();
  const { sales } = usePos();

  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    return queryCustomers(customers, { search });
  }, [customers, search]);

  const customerPurchasesMap = useMemo(() => {
    const map = new Map<string, { count: number; totalSpent: number }>();
    for (const sale of sales) {
      if (!sale.customer_id) continue;
      const prev = map.get(sale.customer_id) ?? { count: 0, totalSpent: 0 };
      map.set(sale.customer_id, {
        count: prev.count + 1,
        totalSpent: prev.totalSpent + (sale.status !== "voided" ? sale.total : 0),
      });
    }
    return map;
  }, [sales]);

  const stats = useMemo(() => {
    const total = customers.length;
    let totalPurchases = 0;
    let totalRevenue = 0;
    for (const data of customerPurchasesMap.values()) {
      totalPurchases += data.count;
      totalRevenue += data.totalSpent;
    }
    return {
      total,
      totalPurchases,
      totalRevenue,
    };
  }, [customers, customerPurchasesMap]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteCustomer(deleteTarget.id);
      toast.success(t("customers.deletedToast"));
      setDeleteTarget(null);
    } catch {
      toast.error(t("common.error"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={t("customers.title")}
        subtitle={t("customers.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.retry")}>
              ⟳
            </Button>
            {/* Exports `filtered` (search applied). Purchase history is always
                computed over every sale, since it belongs to the customer. */}
            <ExportButton
              name="customers"
              count={filtered.length}
              build={() => buildCustomersSheets({ customers: filtered, sales, t })}
            />
            <Button
              onClick={() => {
                setEditingCustomer(null);
                setModalOpen(true);
              }}
            >
              <PlusIcon />
              {t("customers.add")}
            </Button>
          </>
        }
      />

      {/* KPI Stats */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        <StatTile
          label={t("customers.title")}
          value={String(stats.total)}
          tone="primary"
          icon={<UsersIcon className="h-5 w-5 text-indigo-500" />}
        />
        <StatTile
          label={t("customers.totalSales")}
          value={String(stats.totalPurchases)}
          tone="success"
        />
        <StatTile
          label={t("customers.totalSpent")}
          value={num(stats.totalRevenue, 2)}
          tone="info"
        />
      </div>

      {/* Filter / Search Bar */}
      <Card className="mb-4">
        <div className="max-w-md">
          <TextInput
            value={search}
            leading={<SearchIcon />}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("customers.searchPlaceholder")}
            aria-label={t("common.search")}
            type="search"
          />
        </div>
      </Card>

      {/* State views */}
      {error ? (
        <ErrorState
          title={t("customers.loadError")}
          message={error.message}
          retryLabel={t("common.retry")}
          onRetry={() => void refresh()}
        />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon="👥"
            title={t("customers.empty")}
            description={t("customers.emptyHint")}
            action={
              <Button
                onClick={() => {
                  setEditingCustomer(null);
                  setModalOpen(true);
                }}
              >
                <PlusIcon />
                {t("customers.add")}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <div className="alyq-card hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                  <th className="px-4 py-3 text-start font-semibold">{t("customers.name")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("customers.phone")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("customers.address")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("customers.totalSales")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("customers.totalSpent")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("customers.created")}</th>
                  <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const pData = customerPurchasesMap.get(c.id) ?? { count: 0, totalSpent: 0 };
                  return (
                    <tr
                      key={c.id}
                      className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <Link
                          to={`/customers/${c.id}`}
                          className="font-bold text-slate-900 hover:text-indigo-600 hover:underline"
                        >
                          {c.name}
                        </Link>
                        {c.notes && (
                          <p className="line-clamp-1 max-w-xs text-xs text-slate-500">{c.notes}</p>
                        )}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs font-semibold text-slate-700" dir="ltr">
                        {c.phone}
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-600 max-w-xs truncate">
                        {c.address || "—"}
                      </td>
                      <td className="px-3 py-3 text-end text-xs font-bold tabular-nums text-slate-900">
                        {pData.count}
                      </td>
                      <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-indigo-700">
                        {num(pData.totalSpent, 2)}
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-500" dir="ltr">
                        {date(c.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            to={`/customers/${c.id}`}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                            title={t("common.view")}
                          >
                            <EyeIcon />
                          </Link>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCustomer(c);
                              setModalOpen(true);
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                            title={t("common.edit")}
                          >
                            <EditIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(c)}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-rose-500 transition-colors hover:bg-rose-50 hover:text-rose-700"
                            title={t("common.delete")}
                          >
                            <TrashIcon />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {filtered.map((c) => {
              const pData = customerPurchasesMap.get(c.id) ?? { count: 0, totalSpent: 0 };
              return (
                <div key={c.id} className="alyq-card p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <Link
                        to={`/customers/${c.id}`}
                        className="text-sm font-bold text-slate-900 hover:text-indigo-600"
                      >
                        {c.name}
                      </Link>
                      <p className="font-mono text-xs text-slate-600" dir="ltr">
                        {c.phone}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Link
                        to={`/customers/${c.id}`}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
                        title={t("common.view")}
                      >
                        <EyeIcon />
                      </Link>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingCustomer(c);
                          setModalOpen(true);
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
                        title={t("common.edit")}
                      >
                        <EditIcon />
                      </button>
                    </div>
                  </div>

                  {c.address && <p className="text-xs text-slate-600">{c.address}</p>}

                  <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-xs">
                    <span className="text-slate-500">
                      {pData.count} {t("customers.totalSales")}
                    </span>
                    <span className="font-bold tabular-nums text-indigo-700">
                      {num(pData.totalSpent, 2)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Customer Form Modal */}
      {modalOpen && (
        <CustomerFormModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          customer={editingCustomer}
        />
      )}

      {/* Delete Confirmation */}
      {deleteTarget && (
        <ConfirmDialog
          open={Boolean(deleteTarget)}
          title={t("customers.deleteConfirmTitle")}
          body={t("customers.deleteConfirmBody", { name: deleteTarget.name })}
          confirmLabel={t("common.delete")}
          tone="danger"
          loading={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete()}
        />
      )}
    </div>
  );
}
