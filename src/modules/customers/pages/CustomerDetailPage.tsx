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
  SegmentedTabs,
  StatTile,
  UsersIcon,
} from "@/components/ui";
import { useCustomers } from "../hooks/CustomerProvider";
import { CustomerFormModal } from "../components/CustomerFormModal";
import { canAct } from "@/lib/permissions/enforce";
import { usePos } from "@/modules/pos";
import { useReturns } from "@/modules/returns";
import { useCatalog } from "@/modules/products";
import { useOnlineOrders } from "@/modules/online/hooks/OnlineOrdersProvider";
import { WhatsAppUpdatePanel, useWhatsAppUpdates } from "@/modules/online/components/WhatsAppUpdatePanel";
import {
  attributeReturns,
  buildCustomerDirectory,
  favoriteCategories,
  favoriteProducts,
  ordersMatchingCustomer,
  purchaseHistory,
  returnHistory,
  segmentLabelKey,
  type CrmSegment,
} from "../services/crm";

type DetailTab = "overview" | "purchases" | "returns" | "insights" | "communication";

const SEGMENT_TONE: Record<CrmSegment, "info" | "success" | "warning" | "neutral"> = {
  new: "info",
  returning: "success",
  high_value: "warning",
  inactive: "neutral",
};

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, date, num, lang } = useI18n();
  const { customers, loading } = useCustomers();
  const { sales, salesTruncated } = usePos();
  const { returnsList } = useReturns();
  const { products, categories } = useCatalog();
  const { orders } = useOnlineOrders();
  const templates = useWhatsAppUpdates();
  const [modalOpen, setModalOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [orderId, setOrderId] = useState<string>("");

  const customer = useMemo(() => customers.find((entry) => entry.id === id), [customers, id]);

  const directory = useMemo(
    () => buildCustomerDirectory(customers, sales, returnsList),
    [customers, sales, returnsList],
  );

  const ownSales = useMemo(
    () => (id ? directory.attribution.byCustomer.get(id) ?? [] : []),
    [directory, id],
  );
  const ownReturns = useMemo(() => {
    if (!id) return [];
    return attributeReturns(customers, returnsList, directory.attribution.byCustomer).get(id) ?? [];
  }, [customers, returnsList, directory, id]);

  const row = useMemo(
    () => directory.rows.find((entry) => entry.customer.id === id) ?? null,
    [directory, id],
  );

  const orderNumberBySaleId = useMemo(() => {
    const map = new Map<string, string>();
    for (const order of orders) {
      if (order.sale_id) map.set(order.sale_id, order.order_number);
    }
    return map;
  }, [orders]);

  const purchases = useMemo(
    () => purchaseHistory(ownSales, orderNumberBySaleId, lang === "ar" ? "ar" : "en"),
    [ownSales, orderNumberBySaleId, lang],
  );
  const returns = useMemo(
    () => returnHistory(ownReturns, lang === "ar" ? "ar" : "en"),
    [ownReturns, lang],
  );
  const favorites = useMemo(
    () => favoriteProducts(ownSales, products, lang === "ar" ? "ar" : "en"),
    [ownSales, products, lang],
  );
  const categoryRanks = useMemo(
    () => favoriteCategories(favorites, categories),
    [favorites, categories],
  );

  const saleIds = useMemo(() => new Set(ownSales.map((sale) => sale.id)), [ownSales]);
  const matchedOrders = useMemo(
    () => (customer ? ordersMatchingCustomer(customer, orders, saleIds) : []),
    [customer, orders, saleIds],
  );
  const selectedOrder = matchedOrders.find((order) => order.id === orderId) ?? matchedOrders[0] ?? null;

  const duplicateNames = useMemo(() => {
    if (!customer) return [];
    const group = directory.attribution.duplicateGroups.find((entries) =>
      entries.some((entry) => entry.id === customer.id),
    );
    return group ? group.filter((entry) => entry.id !== customer.id).map((entry) => entry.name) : [];
  }, [customer, directory]);

  if (loading && !customer) {
    return (
      <div className="alyq-card">
        <LoadingBlock label={t("common.loading")} />
      </div>
    );
  }

  if (!customer || !row) {
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

  const kpis = row.kpis;
  const statusBadge = (status: string) => {
    if (status === "completed") return <Badge tone="success">{t("pos.status.completed")}</Badge>;
    if (status === "pending") return <Badge tone="warning">{t("pos.status.pending")}</Badge>;
    if (status === "rejected") return <Badge tone="danger">{t("returns.status.rejected")}</Badge>;
    return <Badge tone="neutral">{t(`pos.status.${status}` as "pos.status.voided")}</Badge>;
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
            {canAct("edit_customer") ? (
              <Button variant="secondary" onClick={() => setModalOpen(true)} className="gap-1.5">
                <EditIcon />
                {t("common.edit")}
              </Button>
            ) : null}
            <Link to="/pos" className="alyq-btn-primary alyq-cta h-10 gap-2 rounded-xl px-4 text-sm">
              {t("nav.register")}
            </Link>
          </>
        }
      />

      <div className="mb-4">
        <SegmentedTabs
          ariaLabel={t("customers.details")}
          testId="customer-crm-tabs"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "overview", label: t("customers.tabs.overview") },
            { key: "purchases", label: t("customers.tabs.purchases"), count: purchases.length },
            { key: "returns", label: t("customers.tabs.returns"), count: returns.length },
            { key: "insights", label: t("customers.tabs.insights") },
            { key: "communication", label: t("customers.tabs.communication") },
          ]}
        />
      </div>

      {salesTruncated ? (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          {t("customers.crm.windowNote")}
        </p>
      ) : null}

      {tab === "overview" ? (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
            <Card>
              <div className="flex items-start gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[#faf7f2] text-[#9a7a49]">
                  <UsersIcon className="h-7 w-7" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <h2 className="text-lg font-bold text-slate-900">{customer.name}</h2>
                  <p className="font-mono text-sm font-semibold text-slate-700" dir="ltr">
                    {customer.phone}
                  </p>
                  {customer.email ? <p className="text-xs text-slate-600">{customer.email}</p> : null}
                  <p className="text-xs text-slate-600">{customer.address || "—"}</p>
                  <p className="text-xs text-slate-500">
                    {t("customers.crm.created")}: <span dir="ltr">{date(customer.created_at)}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {t("customers.crm.lastPurchase")}:{" "}
                    <span dir="ltr">{kpis.lastPurchaseAt ? date(kpis.lastPurchaseAt) : "—"}</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {row.segments.map((segment) => (
                      <Badge key={segment} tone={SEGMENT_TONE[segment]}>
                        {t(segmentLabelKey(segment))}
                      </Badge>
                    ))}
                  </div>
                  {customer.notes ? (
                    <div className="mt-2 rounded-xl bg-slate-50 p-2.5 text-xs text-slate-600">
                      <span className="font-semibold text-slate-700">{t("customers.notes")}: </span>
                      {customer.notes}
                    </div>
                  ) : null}
                </div>
              </div>
            </Card>
            <Card>
              <SectionTitle>{t("customers.crm.channel")}</SectionTitle>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-slate-600">{t("customers.crm.pos")}</dt>
                  <dd className="font-bold tabular-nums text-slate-900">
                    {kpis.posCount} · {num(kpis.posPaid, 2)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-slate-600">{t("customers.crm.online")}</dt>
                  <dd className="font-bold tabular-nums text-slate-900">
                    {kpis.onlineCount} · {num(kpis.onlinePaid, 2)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-2">
                  <dt className="font-semibold text-slate-800">{t("customers.crm.combined")}</dt>
                  <dd className="font-bold tabular-nums text-slate-900">
                    {kpis.purchaseCount} · {num(kpis.paidTotal, 2)}
                  </dd>
                </div>
              </dl>
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label={t("customers.crm.paid")} value={num(kpis.paidTotal, 2)} tone="primary" hint={t("customers.crm.count") + `: ${kpis.purchaseCount}`} />
            <StatTile label={t("customers.crm.aov")} value={num(kpis.aov, 2)} tone="info" hint={t("customers.crm.aovHint")} />
            <StatTile label={t("customers.crm.refunds")} value={num(kpis.refundTotal, 2)} tone="warning" />
            <StatTile label={t("customers.crm.net")} value={num(kpis.netValue, 2)} tone="success" hint={t("customers.crm.netHint")} />
          </div>

          {duplicateNames.length > 0 ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
              {t("customers.crm.duplicatesTitle")}: {duplicateNames.join(" · ")}
            </p>
          ) : null}
          <p className="text-xs font-medium leading-relaxed text-slate-600">{t("customers.crm.rules")}</p>
          <Card>
            <div className="flex items-center justify-between gap-3">
              <SectionTitle>{t("customers.purchaseHistory")}</SectionTitle>
              <button type="button" className="text-xs font-bold text-[#9a7a49]" onClick={() => setTab("purchases")}>
                {t("customers.tabs.purchases")}
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              {kpis.purchaseCount} · {num(kpis.paidTotal, 2)}
            </p>
            {purchases.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs font-semibold text-slate-800">
                {purchases.slice(0, 5).map((entry) => (
                  <li key={entry.saleId} dir="ltr">
                    {entry.saleNumber}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>
      ) : null}

      {tab === "purchases" ? (
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <SectionTitle>{t("customers.purchaseHistory")}</SectionTitle>
            <span className="text-xs font-semibold text-slate-500">
              {purchases.length} {t("common.results")}
            </span>
          </div>
          {purchases.length === 0 ? (
            <EmptyState icon="🧾" title={t("customers.noPurchases")} description={t("pos.scanHint")} />
          ) : (
            <div className="space-y-3">
              {purchases.map((purchase) => (
                <article key={purchase.saleId} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <Link to={`/pos/sales/${purchase.saleId}`} className="font-mono text-xs font-bold text-indigo-700 hover:underline" dir="ltr">
                        {purchase.saleNumber}
                      </Link>
                      {purchase.orderNumber ? (
                        <p className="text-[11px] font-semibold text-slate-500" dir="ltr">
                          {purchase.orderNumber}
                        </p>
                      ) : null}
                      <p className="text-xs text-slate-500" dir="ltr">
                        {date(purchase.at)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={purchase.channel === "online" ? "info" : "neutral"}>
                        {purchase.channel === "online" ? t("customers.crm.online") : t("customers.crm.pos")}
                      </Badge>
                      {statusBadge(purchase.status)}
                      {!purchase.counted ? <Badge tone="neutral">{t("customers.crm.notCounted")}</Badge> : null}
                    </div>
                  </div>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-slate-500">{t("customers.crm.gross")}</dt>
                      <dd className="font-bold tabular-nums text-slate-900">{num(purchase.gross, 2)}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">{t("customers.crm.discounts")}</dt>
                      <dd className="font-bold tabular-nums text-slate-900">{num(purchase.discounts, 2)}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">{t("customers.crm.netPaid")}</dt>
                      <dd className="font-bold tabular-nums text-slate-900">{num(purchase.netPaid, 2)}</dd>
                    </div>
                  </dl>
                  <ul className="mt-2 space-y-1 text-xs text-slate-700">
                    {purchase.items.map((item, index) => (
                      <li key={`${purchase.saleId}-${index}`}>
                        {lang === "ar" ? item.nameAr : item.nameEn}
                        {item.variantLabel ? ` · ${item.variantLabel}` : ""} · {item.quantity} · {num(item.lineTotal, 2)}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      {tab === "returns" ? (
        <Card>
          <SectionTitle>{t("customers.returnsHistory")}</SectionTitle>
          {returns.length === 0 ? (
            <p className="mt-3 text-sm font-medium text-slate-600">{t("customers.crm.noReturns")}</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                    <th className="px-2 py-2 text-start">{t("returns.returnNumber")}</th>
                    <th className="px-2 py-2 text-start">{t("returns.saleNumber")}</th>
                    <th className="px-2 py-2 text-start">{t("customers.crm.variant")}</th>
                    <th className="px-2 py-2 text-end">{t("returns.refundAmount")}</th>
                    <th className="px-2 py-2 text-start">{t("pos.cols.status")}</th>
                    <th className="px-2 py-2 text-end">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {returns.map((entry) => (
                    <tr key={entry.returnId} className="border-b border-slate-50">
                      <td className="px-2 py-2">
                        <Link to={`/returns/${entry.returnId}`} className="font-mono text-xs font-bold text-indigo-700 hover:underline">
                          {entry.returnNumber}
                        </Link>
                        <p className="text-[11px] text-slate-500" dir="ltr">{date(entry.at)}</p>
                      </td>
                      <td className="px-2 py-2">
                        <Link to={`/pos/sales/${entry.saleId}`} className="font-mono text-xs font-semibold text-slate-700 hover:underline">
                          {entry.saleNumber}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-700">
                        {entry.items.map((item) => `${lang === "ar" ? item.nameAr : item.nameEn}${item.variantLabel ? ` · ${item.variantLabel}` : ""}`).join(", ") || "—"}
                      </td>
                      <td className="px-2 py-2 text-end font-bold tabular-nums">{num(entry.refundAmount, 2)}</td>
                      <td className="px-2 py-2">
                        {statusBadge(entry.status)}
                        {!entry.counted ? <span className="mt-1 block text-[11px] text-slate-500">{t("customers.crm.notCounted")}</span> : null}
                      </td>
                      <td className="px-2 py-2 text-end">
                        <Link to={`/returns/${entry.returnId}`} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100" title={t("common.view")}>
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
      ) : null}

      {tab === "insights" ? (
        <div className="space-y-4">
          <Card>
            <SectionTitle>{t("customers.crm.favorites")}</SectionTitle>
            {favorites.length === 0 ? (
              <p className="mt-3 text-sm font-medium text-slate-600">{t("customers.crm.noFavorites")}</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-[11px] font-bold uppercase tracking-wider text-slate-600">
                      <th className="px-2 py-2 text-start">{t("export.col.product")}</th>
                      <th className="px-2 py-2 text-start">{t("customers.crm.variant")}</th>
                      <th className="px-2 py-2 text-end">{t("customers.crm.units")}</th>
                      <th className="px-2 py-2 text-end">{t("customers.crm.frequency")}</th>
                      <th className="px-2 py-2 text-end">{t("customers.crm.netPaid")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {favorites.map((item) => (
                      <tr key={item.key} className="border-b border-slate-50">
                        <td className="px-2 py-2">
                          <Link to={`/products/${item.productId}`} className="font-semibold text-slate-900 hover:text-indigo-700 hover:underline">
                            {lang === "ar" ? item.nameAr : item.nameEn}
                          </Link>
                        </td>
                        <td className="px-2 py-2 text-xs text-slate-600">{item.variantLabel || "—"}</td>
                        <td className="px-2 py-2 text-end font-bold tabular-nums">{item.units}</td>
                        <td className="px-2 py-2 text-end tabular-nums">{item.frequency}</td>
                        <td className="px-2 py-2 text-end font-bold tabular-nums">{num(item.netSpend, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card>
            <SectionTitle>{t("customers.crm.categories")}</SectionTitle>
            {categoryRanks.length === 0 ? (
              <p className="mt-3 text-sm font-medium text-slate-600">{t("customers.crm.noFavorites")}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {categoryRanks.map((category) => (
                  <li key={category.categoryId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-semibold text-slate-800">
                      {category.categoryId === "__uncategorized__"
                        ? t("customers.crm.uncategorized")
                        : lang === "ar"
                          ? category.nameAr
                          : category.nameEn}
                    </span>
                    <span className="tabular-nums text-slate-600">
                      {category.units} · {num(category.netSpend, 2)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      {tab === "communication" ? (
        <div className="space-y-3">
          {matchedOrders.length === 0 || !selectedOrder ? (
            <Card>
              <p className="text-sm font-medium leading-relaxed text-slate-600">{t("customers.crm.noOrders")}</p>
            </Card>
          ) : (
            <>
              {matchedOrders.length > 1 ? (
                <label className="block text-xs font-bold text-slate-700">
                  {t("whatsapp.update.template")}
                  <select
                    className="mt-1 h-10 w-full max-w-md rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold"
                    value={selectedOrder.id}
                    onChange={(event) => setOrderId(event.target.value)}
                  >
                    {matchedOrders.map((order) => (
                      <option key={order.id} value={order.id}>
                        {order.order_number} · {order.status}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <WhatsAppUpdatePanel order={selectedOrder} templates={templates} />
            </>
          )}
        </div>
      ) : null}

      {modalOpen ? <CustomerFormModal open={modalOpen} onClose={() => setModalOpen(false)} customer={customer} /> : null}
    </div>
  );
}
