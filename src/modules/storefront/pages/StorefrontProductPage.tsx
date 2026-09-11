import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { StorefrontLayout } from "../components/StorefrontLayout";
import { fetchStorefrontCatalog } from "../data/storefrontCatalog";
import { productName, productDescription, categoryName } from "../data/storefrontQuery";
import type { Product, Category } from "@/modules/products/types";
import { stockStatus } from "@/modules/products/types";

export function StorefrontProductPage() {
  const { id } = useParams<{ id: string }>();
  const { t, money, lang } = useI18n();
  const [product, setProduct] = useState<Product | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStorefrontCatalog()
      .then(({ products, categories }) => {
        setProduct(products.find((p) => p.id === id) ?? null);
        setCategories(categories);
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <StorefrontLayout>
        <div className="py-16 text-center text-sm text-slate-500">{t("common.loading")}</div>
      </StorefrontLayout>
    );
  }

  if (!product) {
    return (
      <StorefrontLayout>
        <div className="rounded-xl border border-slate-200 bg-white py-16 text-center">
          <p className="text-4xl">🔍</p>
          <p className="mt-2 text-sm font-semibold text-slate-700">{t("common.notFound")}</p>
          <Link
            to="/store/products"
            className="mt-4 inline-block rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white"
          >
            {t("storefront.backToProducts")}
          </Link>
        </div>
      </StorefrontLayout>
    );
  }

  const status = stockStatus(product);
  const outOfStock = status === "out";
  const cat = categories.find((c) => c.id === product.category_id);
  const description = productDescription(product, lang);
  const images = [product.image_url, ...(product.images ?? [])].filter(Boolean) as string[];

  return (
    <StorefrontLayout>
      {/* Breadcrumb */}
      <nav className="mb-4 flex items-center gap-2 text-xs text-slate-500">
        <Link to="/store" className="hover:text-indigo-600">
          {t("storefront.home")}
        </Link>
        <span>/</span>
        <Link to="/store/products" className="hover:text-indigo-600">
          {t("storefront.allProducts")}
        </Link>
        {cat && (
          <>
            <span>/</span>
            <Link to={`/store/products?category=${cat.id}`} className="hover:text-indigo-600">
              {categoryName(cat, lang)}
            </Link>
          </>
        )}
      </nav>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* Images */}
        <div>
          <div className="aspect-square overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {product.image_url ? (
              <img
                src={product.image_url}
                alt={productName(product, lang)}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-6xl text-slate-200">
                📦
              </div>
            )}
          </div>
          {images.length > 1 && (
            <div className="mt-3 flex gap-2 overflow-x-auto">
              {images.map((url, i) => (
                <div
                  key={i}
                  className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-slate-200"
                >
                  <img src={url} alt="" className="h-full w-full object-cover" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Details */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{productName(product, lang)}</h1>

          <div className="mt-2 flex items-center gap-3">
            <span className="text-xs font-medium text-slate-500">SKU: {product.sku}</span>
            {product.barcode && (
              <span className="text-xs font-medium text-slate-500">
                {t("products.barcode")}: {product.barcode}
              </span>
            )}
          </div>

          <p className="mt-4 text-3xl font-extrabold text-indigo-700">
            {money(product.selling_price)}
          </p>

          {product.cost_price > 0 && product.cost_price !== product.selling_price && (
            <p className="mt-1 text-sm text-slate-500">
              {product.selling_price > product.cost_price && (
                <span className="font-semibold text-emerald-600">
                  {t("storefront.inStock")}
                </span>
              )}
            </p>
          )}

          <div className="mt-4">
            {outOfStock ? (
              <span className="inline-block rounded-full bg-rose-100 px-4 py-1.5 text-sm font-bold text-rose-700">
                {t("dashboard.outOfStock")}
              </span>
            ) : status === "low" ? (
              <span className="inline-block rounded-full bg-amber-100 px-4 py-1.5 text-sm font-bold text-amber-700">
                {t("storefront.limitedStock")}
              </span>
            ) : (
              <span className="inline-block rounded-full bg-emerald-100 px-4 py-1.5 text-sm font-bold text-emerald-700">
                {t("storefront.inStock")}
              </span>
            )}
          </div>

          {description && (
            <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="mb-2 text-sm font-bold text-slate-700">{t("storefront.description")}</h3>
              <p className="whitespace-pre-line text-sm leading-relaxed text-slate-600">
                {description}
              </p>
            </div>
          )}

          {product.tax_rate > 0 && (
            <p className="mt-4 text-xs text-slate-500">
              {t("storefront.taxIncluded")} ({product.tax_rate}% {t("products.taxRate")})
            </p>
          )}
        </div>
      </div>
    </StorefrontLayout>
  );
}
