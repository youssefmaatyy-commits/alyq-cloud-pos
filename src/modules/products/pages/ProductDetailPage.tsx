import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingBlock,
  useToast,
  Badge,
  Card,
  SectionTitle,
  SegmentedTabs,
} from "@/components/ui";
import { ProductDetails } from "../components/ProductDetails";
import { useCatalog } from "../hooks/CatalogProvider";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { categoryNameIndex } from "../services/categoryTree";
import { describeError } from "../services/catalogService";
import type { Product } from "../types";

/**
 * Product detail (Phase 46 edition).
 *
 * One product, six questions, six tabs — the page-standard order: General
 * (identity and price), Variants (the combination shelf), Stock (movements and
 * the adjustment hand-off), Website (what the store shows), Media (imagery),
 * History (when it changed and where it is referenced). Everything on every tab
 * is display over existing sources — the edit page owns the lifecycle, the
 * inventory screen owns the counts, the website centre owns the storefront copy
 * — so this page never becomes a second place where the same fact disagrees
 * with its owner.
 */
type DetailTab = "general" | "variants" | "stock" | "website" | "media" | "history";

export function ProductDetailPage() {
  const { t, pick, num, date, money } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const {
    products,
    categories,
    productReferences,
    variantsByProduct,
    loading,
    error,
    refresh,
    setProductActive,
    deleteProduct,
  } = useCatalog();
  // The stock movement book lives with the inventory provider (already mounted
  // in the authenticated tree) — read-only here.
  const { movements } = useInventory();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Product | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [tab, setTab] = useState<DetailTab>("general");

  const product = id ? products.find((p) => p.id === id) : undefined;

  const nameIndex = categoryNameIndex(categories, pick);
  const categoryName = (cid: string | null) =>
    cid ? nameIndex.get(cid) ?? "—" : t("products.withoutCategory");

  const variants = useMemo(
    () => (product ? variantsByProduct.get(product.id) ?? [] : []),
    [product, variantsByProduct],
  );
  const productMovements = useMemo(
    () => (product ? movements.filter((m) => m.product_id === product.id) : []),
    [product, movements],
  );

  const confirmToggle = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await setProductActive(pending.id, !pending.active);
      toast.success(t(pending.active ? "products.archivedToast" : "products.restoredToast"));
      setPending(null);
    } catch (err) {
      toast.error(t(describeError(err).key as never));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!product || busy) return;
    setBusy(true);
    try {
      await deleteProduct(product.id);
      toast.success(t("products.deletedToast"));
      setPendingDelete(false);
      // The record is gone for good — there is nothing left to show.
      navigate("/products");
    } catch (err) {
      toast.error(t(describeError(err).key as never));
      setPendingDelete(false);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <ErrorState
        title={t("products.errorLoad")}
        message={error.message}
        retryLabel={t("common.retry")}
        onRetry={() => void refresh()}
      />
    );
  }

  if (loading && !product) {
    return <LoadingBlock label={t("common.loading")} />;
  }

  if (!product) {
    return (
      <div>
        <PageHeader backTo="/products" backLabel={t("common.back")} title={t("common.notFound")} />
        <div className="alyq-card p-6 text-sm font-medium text-slate-700">
          {t("common.noResultsHint")}
          <div className="mt-4">
            <Button onClick={() => navigate("/products")}>{t("products.title")}</Button>
          </div>
        </div>
      </div>
    );
  }

  const references = productReferences[product.id];

  return (
    <div>
      <PageHeader
        backTo="/products"
        backLabel={t("common.back")}
        title={pick(product.name_ar, product.name_en)}
        subtitle={`${product.sku} · ${categoryName(product.category_id)}`}
        actions={
          <Link
            to={`/products/${product.id}/edit`}
            className="alyq-btn-primary alyq-cta h-10 rounded-xl px-4 text-sm"
          >
            {t("common.edit")}
          </Link>
        }
      />

      <SegmentedTabs<DetailTab>
        ariaLabel={t("products.view")}
        testId="product-detail-tabs"
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "general", label: t("products.tabs.general") },
          { key: "variants", label: t("products.tabs.variants"), count: variants.length },
          { key: "stock", label: t("products.tabs.stock") },
          { key: "website", label: t("products.tabs.website") },
          { key: "media", label: t("products.tabs.media") },
          { key: "history", label: t("products.tabs.history") },
        ]}
      />

      {tab === "general" ? (
        <ProductDetails
          product={product}
          categoryName={categoryName}
          busy={busy}
          onToggleActive={() => setPending(product)}
          onDelete={() => setPendingDelete(true)}
          deleteBlockedReason={
            (references?.total ?? 0) > 0 ? t("products.errorHasHistory") : null
          }
        />
      ) : null}

      {/* Phase 43: the shelf, combination by combination — read-only here; the
          edit page owns the lifecycle, the inventory screen owns the counts. */}
      {tab === "variants" ? (
        variants.length > 0 ? (
          <Card data-testid="product-variant-list">
            <SectionTitle>{t("products.variants.detailsTitle")}</SectionTitle>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100 text-start text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2 text-start">{t("products.variants.colCombination")}</th>
                    <th className="px-3 py-2 text-start">{t("products.sku")}</th>
                    <th className="px-3 py-2 text-end">{t("products.variants.colStock")}</th>
                    <th className="px-3 py-2 text-end">{t("products.variants.colPrice")}</th>
                    <th className="px-3 py-2 text-start">{t("products.variants.colStatus")}</th>
                  </tr>
                </thead>
                <tbody>
                  {variants.map((variant) => (
                    <tr key={variant.id} className="border-b border-slate-50 last:border-0">
                      <td className="px-3 py-2 font-bold text-slate-900">
                        {pick(variant.color_ar, variant.color_en) || t("store.variants.defaultColor")}
                        {" / "}
                        <span className="tabular-nums">
                          {variant.size !== null
                            ? Math.round(variant.size * 100) / 100
                            : variant.size_label}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-600">{variant.sku}</td>
                      <td className="px-3 py-2 text-end font-bold tabular-nums">
                        {num(variant.stock_quantity, 0)}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums text-slate-600">
                        {variant.price_override != null ? money(variant.price_override) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {!variant.active ? (
                          <Badge tone="neutral">{t("products.variants.statusArchived")}</Badge>
                        ) : variant.stock_quantity <= 0 ? (
                          <Badge tone="danger">{t("products.variants.statusOut")}</Badge>
                        ) : variant.low_stock_level > 0 && variant.stock_quantity <= variant.low_stock_level ? (
                          <Badge tone="warning">{t("products.variants.statusLow")}</Badge>
                        ) : (
                          <Badge tone="success">{t("products.variants.statusIn")}</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <Card>
            <EmptyState
              icon="🍫"
              title={t("products.variants.noneTitle")}
              description={t("products.variants.noneHint")}
              action={
                <Link to={`/products/${product.id}/edit`}>
                  <Button variant="secondary">{t("common.edit")}</Button>
                </Link>
              }
            />
          </Card>
        )
      ) : null}

      {tab === "stock" ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                {t("inventory.cols.quantity")}
              </p>
              <p className="mt-1 text-xl font-black tabular-nums text-stone-900">
                {product.stock_tracking_enabled ? num(product.stock_quantity, 0) : "—"}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                {t("products.lowStockLevel")}
              </p>
              <p className="mt-1 text-xl font-black tabular-nums text-stone-900">
                {product.stock_tracking_enabled ? num(product.low_stock_level, 0) : "—"}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                {t("products.stockTracking")}
              </p>
              <p className="mt-1 text-sm font-bold text-stone-900">
                {product.stock_tracking_enabled ? t("common.yes") : t("common.no")}
              </p>
            </Card>
          </div>
          <Card>
            <div className="mb-2 flex items-center justify-between">
              <SectionTitle>{t("inventory.history")}</SectionTitle>
              <Link to="/inventory">
                <Button variant="secondary" size="sm">{t("inventory.adjust")}</Button>
              </Link>
            </div>
            {productMovements.length === 0 ? (
              <p className="py-5 text-center text-sm font-medium text-stone-500">
                {t("inventory.history.empty")}
              </p>
            ) : (
              <div className="divide-y divide-stone-100">
                {productMovements.slice(0, 12).map((movement) => (
                  <div key={movement.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-bold text-stone-800">
                        {t(`inventory.type.${movement.type}` as never)} · {t(`inventory.reason.${movement.reason}` as never)}
                      </p>
                      <p className="text-[11px] text-stone-500">{date(movement.created_at)}</p>
                    </div>
                    <span
                      className={`shrink-0 text-sm font-black tabular-nums ${
                        movement.delta >= 0 ? "text-emerald-700" : "text-rose-700"
                      }`}
                    >
                      {movement.delta >= 0 ? "+" : ""}
                      {num(movement.delta, 0)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {tab === "website" ? (
        <Card data-testid="product-website-tab">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-black text-stone-900">{t("products.websiteVisibility")}</p>
              <p className="mt-0.5 text-xs font-medium text-stone-500">
                {product.show_on_website ? t("products.websiteVisibleHint") : t("products.hiddenOnWebsite")}
              </p>
            </div>
            <Badge tone={product.show_on_website ? "success" : "neutral"}>
              {product.show_on_website ? t("common.yes") : t("common.no")}
            </Badge>
          </div>
          <div className="mt-4 space-y-3">
            {product.description_ar ? (
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500" dir="rtl">
                  {t("products.descriptionAr")}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm font-medium leading-relaxed text-stone-800" dir="rtl">
                  {product.description_ar}
                </p>
              </div>
            ) : null}
            {product.description_en ? (
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                  {t("products.descriptionEn")}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm font-medium leading-relaxed text-stone-800">
                  {product.description_en}
                </p>
              </div>
            ) : null}
          </div>
          <div className="mt-4 flex gap-2">
            <Link to={`/products/${product.id}/edit`}>
              <Button variant="secondary" size="sm">{t("common.edit")}</Button>
            </Link>
            <Link to={`/store/products/${product.id}`}>
              <Button variant="ghost" size="sm">{t("nav.viewStore")}</Button>
            </Link>
          </div>
        </Card>
      ) : null}

      {tab === "media" ? (
        <Card data-testid="product-media-tab">
          {product.image_url || (product.images ?? []).length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
              <div className="overflow-hidden rounded-2xl border border-stone-200 bg-[#faf7f2]">
                {product.image_url ? (
                  <img
                    src={product.image_url}
                    alt={pick(product.name_ar, product.name_en)}
                    className="aspect-square w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="grid aspect-square place-items-center text-3xl font-black text-[#d8c7a7]">
                    {pick(product.name_ar, product.name_en).charAt(0)}
                  </div>
                )}
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                  {t("products.media.gallery")}
                </p>
                {(product.images ?? []).length > 0 ? (
                  <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {(product.images ?? []).map((url, index) => (
                      <img
                        key={`${url}-${index}`}
                        src={url}
                        alt={`${pick(product.name_ar, product.name_en)} ${index + 1}`}
                        className="aspect-square w-full rounded-xl border border-stone-200 object-cover"
                        loading="lazy"
                      />
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs font-medium text-stone-400">{t("products.media.noGallery")}</p>
                )}
              </div>
            </div>
          ) : (
            <EmptyState
              icon="🖼"
              title={t("products.media.noneTitle")}
              description={t("products.media.noneHint")}
              action={
                <Link to={`/products/${product.id}/edit`}>
                  <Button variant="secondary">{t("common.edit")}</Button>
                </Link>
              }
            />
          )}
        </Card>
      ) : null}

      {tab === "history" ? (
        <Card data-testid="product-history-tab">
          <div className="divide-y divide-stone-100">
            <Row label={t("products.history.created")} value={date(product.created_at)} />
            <Row label={t("products.history.updated")} value={date(product.updated_at)} />
            <Row
              label={t("products.history.references")}
              value={
                references
                  ? t("products.history.referenceCount", { count: references.total })
                  : t("products.history.noReferences")
              }
            />
          </div>
          <p className="mt-3 text-[11px] font-medium leading-relaxed text-stone-500">
            {t("products.history.note")}
          </p>
        </Card>
      ) : null}

      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.active ? t("products.deleteConfirmTitle") : t("products.restoreConfirmTitle")}
        body={t(
          pending?.active ? "products.deleteConfirmBody" : "products.restoreConfirmBody",
          { name: pending ? pick(pending.name_ar, pending.name_en) : "" },
        )}
        confirmLabel={pending?.active ? t("common.archive") : t("common.restore")}
        tone={pending?.active ? "danger" : "primary"}
        loading={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => void confirmToggle()}
      />
      <ConfirmDialog
        open={pendingDelete}
        title={t("products.permanentDeleteTitle")}
        body={t("products.permanentDeleteBody", { name: pick(product.name_ar, product.name_en) })}
        confirmLabel={t("products.permanentDelete")}
        tone="danger"
        loading={busy}
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-2">
      <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500">{label}</span>
      <span className="text-sm font-semibold text-stone-900">{value}</span>
    </div>
  );
}
