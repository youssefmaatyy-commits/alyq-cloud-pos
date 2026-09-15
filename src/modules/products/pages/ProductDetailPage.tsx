import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import { Button, ConfirmDialog, ErrorState, LoadingBlock, useToast } from "@/components/ui";
import { ProductDetails } from "../components/ProductDetails";
import { useCatalog } from "../hooks/CatalogProvider";
import { categoryNameIndex } from "../services/categoryTree";
import { describeError } from "../services/catalogService";
import type { Product } from "../types";

export function ProductDetailPage() {
  const { t, pick } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { products, categories, productReferences, loading, error, refresh, setProductActive, deleteProduct } =
    useCatalog();
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
