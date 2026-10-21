import { useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import { ProductForm } from "../components/ProductForm";
import { VariantEditor, type VariantEditorHandle } from "../components/VariantEditor";
import { useCatalog } from "../hooks/CatalogProvider";

export function ProductFormPage({ mode }: { mode: "create" | "edit" }) {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const { products, variantsByProduct, refresh } = useCatalog();
  const existing = id ? products.find((p) => p.id === id) : undefined;
  const variantEditorRef = useRef<VariantEditorHandle | null>(null);
  const [variantsDirty, setVariantsDirty] = useState(false);

  return (
    <div className="min-w-0 max-w-full">
      <PageHeader
        backTo={id ? `/products/${id}` : "/products"}
        backLabel={t("common.back")}
        title={
          mode === "create" || !existing ? t("products.new") : t("products.edit")
        }
        subtitle={
          existing ? `${existing.sku} · ${existing.name_en}` : t("products.subtitle")
        }
      />
      {/* The same simple colour/size editor used by Add Product is a first-class
          section on Edit Product, not hidden below the long product form or
          folded into an advanced modal. It saves separately because each
          existing shelf has its own identity, stock ledger and archive guard. */}
      {existing ? (
        <div className="mb-4 min-w-0">
          <VariantEditor
            ref={variantEditorRef}
            product={existing}
            variants={variantsByProduct.get(existing.id) ?? []}
            onChanged={() => refresh()}
            onDirtyChange={setVariantsDirty}
          />
        </div>
      ) : null}
      <ProductForm
        productId={mode === "edit" ? id : undefined}
        variantsDirty={variantsDirty}
        onSavePendingVariants={
          existing
            ? async () => (await variantEditorRef.current?.saveIfDirty()) ?? true
            : undefined
        }
      />
    </div>
  );
}
