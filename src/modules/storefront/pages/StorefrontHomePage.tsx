import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { StorefrontLayout } from "../components/StorefrontLayout";
import { fetchStorefrontCatalog } from "../data/storefrontCatalog";
import { productName, categoryName } from "../data/storefrontQuery";
import type { Product, Category } from "@/modules/products/types";
import { stockStatus } from "@/modules/products/types";

export function StorefrontHomePage() {
  const { t, money, lang } = useI18n();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStorefrontCatalog()
      .then(({ products, categories }) => {
        setProducts(products);
        setCategories(categories);
      })
      .catch(() => {
        /* silent — empty storefront */
      })
      .finally(() => setLoading(false));
  }, []);

  const featured = products.filter((p) => p.is_featured).slice(0, 8);
  const inStock = products.filter((p) => stockStatus(p) !== "out");

  return (
    <StorefrontLayout>
      {/* Hero */}
      <section className="mb-8 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-700 px-8 py-12 text-center text-white">
        <h1 className="text-3xl font-extrabold tracking-tight">{t("storefront.welcome")}</h1>
        <p className="mt-2 text-base font-medium text-indigo-100">{t("storefront.welcomeSubtitle")}</p>
        <Link
          to="/store/products"
          className="mt-6 inline-block rounded-xl bg-white px-6 py-3 text-sm font-bold text-indigo-700 shadow-md transition hover:bg-indigo-50"
        >
          {t("storefront.browseAll")}
        </Link>
      </section>

      {loading ? (
        <div className="py-16 text-center text-sm text-slate-500">{t("common.loading")}</div>
      ) : (
        <>
          {/* Featured products */}
          {featured.length > 0 && (
            <section className="mb-10">
              <h2 className="mb-4 text-lg font-bold text-slate-900">{t("storefront.featured")}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {featured.map((product) => (
                  <ProductCard key={product.id} product={product} lang={lang} money={money} />
                ))}
              </div>
            </section>
          )}

          {/* Categories */}
          {categories.length > 0 && (
            <section className="mb-10">
              <h2 className="mb-4 text-lg font-bold text-slate-900">{t("storefront.categories")}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {categories.map((cat) => {
                  const count = inStock.filter((p) => p.category_id === cat.id).length;
                  return (
                    <Link
                      key={cat.id}
                      to={`/store/products?category=${cat.id}`}
                      className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-indigo-300 hover:shadow-sm"
                    >
                      <span className="text-sm font-semibold text-slate-800">
                        {categoryName(cat, lang)}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-600">
                        {count}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          {/* All available */}
          <section>
            <h2 className="mb-4 text-lg font-bold text-slate-900">{t("storefront.available")}</h2>
            {inStock.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">{t("storefront.noProducts")}</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {inStock.slice(0, 12).map((product) => (
                  <ProductCard key={product.id} product={product} lang={lang} money={money} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </StorefrontLayout>
  );
}

function ProductCard({
  product,
  lang,
  money,
}: {
  product: Product;
  lang: "en" | "ar";
  money: (v: number) => string;
}) {
  const status = stockStatus(product);
  const outOfStock = status === "out";

  return (
    <Link
      to={`/store/products/${product.id}`}
      className="group overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:border-indigo-300 hover:shadow-md"
    >
      <div className="aspect-square bg-slate-100">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={productName(product, lang)}
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl text-slate-300">📦</div>
        )}
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-slate-900">{productName(product, lang)}</p>
        <p className="mt-0.5 text-xs text-slate-500">{product.sku}</p>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-sm font-bold text-indigo-700">{money(product.selling_price)}</span>
          {outOfStock ? (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">
              Out of stock
            </span>
          ) : status === "low" ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              Low stock
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
