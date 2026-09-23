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
  Badge,
  SelectInput,
  useToast,
} from "@/components/ui";
import { buildCustomersSheets } from "../services/customersExport";
import { useCustomers } from "../hooks/CustomerProvider";
import { CustomerFormModal } from "../components/CustomerFormModal";
import type { Customer } from "../types";
import { buildCustomerDirectory, queryDirectory, segmentLabelKey, type CrmSortKey } from "../services/crm";
import { usePos } from "@/modules/pos";
import { useReturns } from "@/modules/returns";
import { canAct } from "@/lib/permissions/enforce";

export function CustomersPage() {
  const { t, date, num } = useI18n();
  const toast = useToast();
  const { customers, loading, error, refresh, deleteCustomer } = useCustomers();
  const { sales, salesTruncated } = usePos();
  const { returnsList } = useReturns();

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<CrmSortKey>("book");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Phase 17: the three acts on this screen are three capabilities. Hiding the
  // button is the courtesy; `customerService` asserts the same capability, and in
  // live mode the row-level policies assert it again — so a hand-built request
  // meets the same answer the UI gave.
  const mayAdd = canAct("add_customer");
  const mayEdit = canAct("edit_customer");
  const mayDelete = canAct("delete_customer");

  const directory = useMemo(
    () => buildCustomerDirectory(customers, sales, returnsList),
    [customers, sales, returnsList],
  );
  const filtered = useMemo(
    () => queryDirectory(directory.rows, search, sort),
    [directory, search, sort],
  );
  const filteredCustomers = useMemo(() => filtered.map((row) => row.customer), [filtered]);

  const stats = useMemo(() => {
    let totalPurchases = 0;
    let totalRevenue = 0;
    let netValue = 0;
    for (const row of directory.rows) {
      totalPurchases += row.kpis.purchaseCount;
      totalRevenue += row.kpis.paidTotal;
      netValue += row.kpis.netValue;
    }
    return {
      total: customers.length,
      totalPurchases,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      netValue: Math.round(netValue * 100) / 100,
    };
  }, [customers.length, directory.rows]);

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
              count={filteredCustomers.length}
              build={() => buildCustomersSheets({ customers: filteredCustomers, book: customers, sales, returnsList, t })}
            />
            {mayAdd ? (
              <Button
                onClick={() => {
                  setEditingCustomer(null);
                  setModalOpen(true);
                }}
              >
                <PlusIcon />
                {t("customers.add")}
              </Button>
            ) : null}
          </>
        }
      />

      {/* KPI Stats */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
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
        <StatTile
          label={t("customers.crm.net")}
          value={num(stats.netValue, 2)}
          tone="primary"
        />
      </div>

      {directory.attribution.duplicateGroups.length > 0 ? (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950" data-testid="customer-duplicate-phones">
          <p className="font-bold">{t("customers.crm.duplicatesTitle")}</p>
          <p className="mt-1 text-xs leading-relaxed">
            {t("customers.crm.duplicatesBody", {
              count: directory.attribution.duplicateGroups.reduce((sum, group) => sum + group.length, 0),
            })}
          </p>
        </div>
      ) : null}
      {salesTruncated ? (
        <p className="mb-4 text-xs font-medium text-slate-500">{t("customers.crm.windowNote")}</p>
      ) : null}

      {/* Filter / Search Bar */}
      <Card className="mb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <TextInput
              value={search}
              leading={<SearchIcon />}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("customers.searchPlaceholder")}
              aria-label={t("common.search")}
              type="search"
            />
          </div>
          <label className="block text-xs font-bold text-slate-600 sm:w-56">
            {t("customers.sort.label")}
            <SelectInput
              className="mt-1"
              value={sort}
              aria-label={t("customers.sort.label")}
              onChange={(event) => setSort(event.target.value as CrmSortKey)}
            >
              <option value="book">{t("customers.sort.book")}</option>
              <option value="spend">{t("customers.sort.spend")}</option>
              <option value="orders">{t("customers.sort.orders")}</option>
              <option value="recent">{t("customers.sort.recent")}</option>
              <option value="inactive">{t("customers.sort.inactive")}</option>
            </SelectInput>
          </label>
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
                  <th className="px-3 py-3 text-end font-semibold">{t("customers.crm.count")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("customers.crm.paid")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("customers.crm.net")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("customers.crm.lastPurchase")}</th>
                  <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const c = row.customer;
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
                        {c.email ? <p className="line-clamp-1 max-w-xs text-xs text-slate-500">{c.email}</p> : null}
                        {row.segments.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {row.segments.map((segment) => (
                              <Badge key={segment} tone="neutral">{t(segmentLabelKey(segment))}</Badge>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs font-semibold text-slate-700" dir="ltr">
                        {c.phone}
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-600 max-w-xs truncate">
                        {c.address || "—"}
                      </td>
                      <td className="px-3 py-3 text-end text-xs font-bold tabular-nums text-slate-900">
                        {row.kpis.purchaseCount}
                      </td>
                      <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-slate-900">
                        {num(row.kpis.paidTotal, 2)}
                      </td>
                      <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-indigo-700">
                        {num(row.kpis.netValue, 2)}
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-500" dir="ltr">
                        {row.kpis.lastPurchaseAt ? date(row.kpis.lastPurchaseAt) : "—"}
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
                          {mayEdit ? (
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
                          ) : null}
                          {mayDelete ? (
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(c)}
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-rose-500 transition-colors hover:bg-rose-50 hover:text-rose-700"
                              title={t("common.delete")}
                            >
                              <TrashIcon />
                            </button>
                          ) : null}
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
            {filtered.map((row) => {
              const c = row.customer;
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
                      {row.kpis.purchaseCount} {t("customers.crm.count")}
                    </span>
                    <span className="font-bold tabular-nums text-indigo-700">
                      {num(row.kpis.netValue, 2)}
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
