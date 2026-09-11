import { useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import { ProductForm } from "../components/ProductForm";
import { useCatalog } from "../hooks/CatalogProvider";

export function ProductFormPage({ mode }: { mode: "create" | "edit" }) {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const { products } = useCatalog();
  const existing = id ? products.find((p) => p.id === id) : undefined;

  return (
    <div>
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
      <ProductForm productId={mode === "edit" ? id : undefined} />
    </div>
  );
}
