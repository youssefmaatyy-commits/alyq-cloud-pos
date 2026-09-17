import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import { Button, ConfirmDialog, ErrorState, LoadingBlock, useToast, Badge, Card, SectionTitle } from "@/components/ui";
import { ProductDetails } from "../components/ProductDetails";
import { useCatalog } from "../hooks/CatalogProvider";
import { categoryNameIndex } from "../services/categoryTree";
import { describeError } from "../services/catalogService";
import type { Product } from "../types";

export function ProductDetailPage() {
  const { t, pick, num } = useI18n();
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
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Product | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);

  const product = id ? products.find((p) => p.id === id) : undefined;

  const nameIndex = categoryNameIndex(categories, pick);
  const categoryName = (cid: string | null) =>
    cid ? nameIndex.get(cid) ?? "—" : t("products.withoutCategory");

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

  return (
    <div>
      <PageHeader
        backTo="/products"
        backLabel={t("common.back")}
        title={t("products.view")}
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
      <ProductDetails
        product={product}
        categoryName={categoryName}
        busy={busy}
        onToggleActive={() => setPending(product)}
        onDelete={() => setPendingDelete(true)}
        deleteBlockedReason={
          (productReferences[product.id]?.total ?? 0) > 0 ? t("products.errorHasHistory") : null
        }
      />
      {/* Phase 43: the shelf, combination by combination — read-only here; the
          edit page owns the lifecycle, the inventory screen owns the counts. */}
      {(variantsByProduct.get(product.id) ?? []).length > 0 ? (
        <Card className="mt-4" data-testid="product-variant-list">
          <SectionTitle>{t("products.variants.detailsTitle")}</SectionTitle>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-start text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2 text-start">{t("products.variants.colCombination")}</th>
                  <th className="px-3 py-2 text-start">{t("products.sku")}</th>
                  <th className="px-3 py-2 text-end">{t("products.variants.colStock")}</th>
                  <th className="px-3 py-2 text-start">{t("products.variants.colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {(variantsByProduct.get(product.id) ?? []).map((variant) => (
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
