/**
 * The product page.
 *
 * A gallery with zoom, the campaign price beside the catalogue price, the specs
 * an admin wrote, what else goes with it, and the two things a shopper came for:
 * whether it is in stock and how to buy it.
 *
 * It is also the page that has to work hardest for search, so it writes the
 * document `<title>`, the meta description, the canonical URL, the share card and
 * `schema.org/Product` JSON-LD from the product's own SEO fields — and clears all
 * of it on the way out, because the POS is rendered from the same document.
 *
 * Zoom is a transform on the existing image rather than a second download: a
 * shopper on a phone gets the detail without paying for a full-size file twice.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import { useStorefront } from "../hooks/StorefrontProvider";
import { useStoreCart } from "../hooks/StoreCartProvider";
import { useStoreAccount } from "../hooks/StoreAccountProvider";
import {
  findCatalogProduct,
  relatedProducts,
  searchCatalog,
  EMPTY_CATALOG_FILTERS,
} from "../services/catalogQuery";
import {
  applyDocumentMeta,
  applyJsonLd,
  clearDocumentMeta,
  descriptionForProduct,
  productJsonLd,
  productPath,
  titleForProduct,
  absoluteUrl,
} from "../services/seo";
import { campaignBadgeText } from "../services/badges";
import { Money, ProductBadges, QuantityStepper, StarRating, StoreImage } from "../components/storefront/StorePrimitives";
import { ProductCard, ProductGrid } from "../components/storefront/ProductCard";

/** How far the zoomed image follows the pointer. */
const ZOOM = 2;

export function StoreProductPage() {
  const { key = "" } = useParams<{ key: string }>();
  const { t, pick, lang } = useI18n();
  const {
    products,
    contents,
    contentByProduct,
    categories,
    catalogContext,
    campaigns,
    reviews,
    settings,
  } = useStorefront();
  const { add, setQuantity, lines } = useStoreCart();
  const { inWishlist, toggleWishlist, customer } = useStoreAccount();

  const product = useMemo(
    () => findCatalogProduct(key, products, contents),
    [contents, key, products],
  );

  const [imageIndex, setImageIndex] = useState(0);
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const [quantity, setLocalQuantity] = useState(1);
  const [copied, setCopied] = useState(false);

  const content = product ? contentByProduct.get(product.id) ?? null : null;
  const entry = useMemo(
    () =>
      product
        ? searchCatalog(
            [product],
            { ...EMPTY_CATALOG_FILTERS, productIds: [product.id] },
            catalogContext,
          )[0] ?? null
        : null,
    [catalogContext, product],
  );

  const gallery = useMemo(() => {
    if (!product) return [];
    return [product.image_url, ...product.images].filter(
      (url): url is string => Boolean(url && url.trim()),
    );
  }, [product]);

  const category = product?.category_id
    ? categories.find((candidate) => candidate.id === product.category_id) ?? null
    : null;

  const related = useMemo(
    () => (product ? relatedProducts(product, products, catalogContext, 4) : []),
    [catalogContext, product, products],
  );

  const productReviews = useMemo(
    () => (product ? reviews.filter((review) => review.product_id === product.id && review.visible) : []),
    [product, reviews],
  );

  const inCart = product ? lines.find((line) => line.product_id === product.id)?.quantity ?? 0 : 0;

  // Search and share metadata, per product, cleaned up on the way out.
  useEffect(() => {
    if (!product || !entry) return;
    const name = pick(product.name_ar, product.name_en);
    const baseUrl =
      typeof window === "undefined"
        ? ""
        : window.location.href.split("#")[0];
    const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en);

    applyDocumentMeta({
      title: titleForProduct({
        name,
        seoTitle: content?.seo_title ?? null,
        storeName,
      }),
      description: descriptionForProduct({
        seoDescription: content?.seo_description,
        productDescription: pick(product.description_ar, product.description_en),
        fallbackName: name,
      }),
      canonical: absoluteUrl(baseUrl, productPath(product, content)),
      ogImage: gallery[0] ?? settings.seo.og_image_url,
      ogType: "product",
      locale: lang === "ar" ? "ar_EG" : "en_US",
      siteName: storeName,
    });
    applyJsonLd(
      productJsonLd({
        product,
        content,
        categoryName: category ? pick(category.name_ar, category.name_en) : null,
        price: entry.price,
        baseUrl,
        storeName,
        pick,
      }),
    );

    return () => {
      clearDocumentMeta();
    };
  }, [category, content, entry, gallery, lang, pick, product, settings.contact.store_name_ar, settings.contact.store_name_en, settings.seo.og_image_url]);

  const share = useCallback(async () => {
    if (typeof window === "undefined") return;
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ url, title: document.title });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sharing is a convenience; failing silently is better than an error the
      // shopper cannot act on.
    }
  }, []);

  if (!product || !entry) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-20 text-center">
        <p className="text-lg font-black text-[var(--store-text)]">{t("common.notFound")}</p>
        <p className="mt-2 text-sm text-[var(--store-muted)]">{t("store.product.notFoundHint")}</p>
        <Link
          to="/store/products"
          className="mt-6 inline-block bg-[var(--store-primary)] px-5 py-2.5 text-sm font-bold text-[var(--store-on-primary)]"
          style={{ borderRadius: "var(--store-radius-button)" }}
        >
          {t("store.product.browseAll")}
        </Link>
      </div>
    );
  }

  const name = pick(product.name_ar, product.name_en);
  const description = pick(product.description_ar, product.description_en);
  const specs = content?.specs ?? [];
  const brand = pick(content?.brand_ar ?? null, content?.brand_en ?? null);
  const badgeText = campaignBadgeText(product.id, campaigns, (arabic, english) => pick(arabic, english));
  const available = entry.available;
  const maxQuantity = available === null ? 99 : Math.max(available, 0);
  const wished = inWishlist(product.id);

  return (
    <div className="mx-auto w-full max-w-[var(--store-max-width,72rem)] px-4 py-6 sm:px-6">
      <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[var(--store-muted)]" aria-label={t("store.product.breadcrumb")}>
        <Link to="/store" className="hover:text-[var(--store-primary)]">{t("store.nav.home")}</Link>
        <span aria-hidden>/</span>
        <Link to="/store/products" className="hover:text-[var(--store-primary)]">{t("store.nav.products")}</Link>
        {category ? (
          <>
            <span aria-hidden>/</span>
            <Link
              to={`/store/products?category=${encodeURIComponent(category.id)}`}
              className="hover:text-[var(--store-primary)]"
            >
              {pick(category.name_ar, category.name_en)}
            </Link>
          </>
        ) : null}
        <span aria-hidden>/</span>
        <span className="truncate text-[var(--store-text)]">{name}</span>
      </nav>

      <div className="grid gap-8 lg:grid-cols-2">
        <div>
          <div
            className="relative overflow-hidden border border-[var(--store-border)] bg-[var(--store-surface)]"
            style={{ borderRadius: "var(--store-radius)" }}
            onMouseEnter={() => setZoom({ x: 50, y: 50 })}
            onMouseLeave={() => setZoom(null)}
            onMouseMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setZoom({
                x: ((event.clientX - box.left) / box.width) * 100,
                y: ((event.clientY - box.top) / box.height) * 100,
              });
            }}
          >
            <StoreImage
              src={gallery[imageIndex] ?? null}
              alt={name}
              ratio="aspect-square"
              priority
              sizes="(max-width: 1024px) 100vw, 50vw"
              style={
                zoom
                  ? { transform: `scale(${ZOOM})`, transformOrigin: `${zoom.x}% ${zoom.y}%`, transition: "transform 80ms linear" }
                  : undefined
              }
            />
            {entry.badges.length > 0 ? (
              <ProductBadges badges={entry.badges} text={badgeText} className="absolute top-3 p-0" />
            ) : null}
          </div>

          {gallery.length > 1 ? (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {gallery.map((url, index) => (
                <button
                  key={url + index}
                  type="button"
                  onClick={() => setImageIndex(index)}
                  aria-label={t("store.product.viewImage", { number: index + 1 })}
                  aria-current={index === imageIndex}
                  className={cn(
                    "h-16 w-16 shrink-0 overflow-hidden border-2 transition",
                    index === imageIndex
                      ? "border-[var(--store-primary)]"
                      : "border-[var(--store-border)] opacity-70 hover:opacity-100",
                  )}
                  style={{ borderRadius: "var(--store-radius)" }}
                >
                  <img src={url} alt="" aria-hidden loading="lazy" decoding="async" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          ) : null}
          {gallery.length > 0 ? (
            <p className="mt-2 text-[11px] font-medium text-[var(--store-muted)]">{t("store.product.zoomHint")}</p>
          ) : null}
        </div>

        <div>
          {brand ? (
            <p className="text-xs font-black uppercase tracking-widest text-[var(--store-muted)]">{brand}</p>
          ) : null}
          <h1 className="mt-1 text-2xl font-black leading-tight tracking-tight text-[var(--store-text)] sm:text-3xl">
            {name}
          </h1>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-semibold text-[var(--store-muted)]">
            <span>{t("store.product.sku")}: {product.sku}</span>
            {product.barcode ? <span>{t("store.product.barcode")}: {product.barcode}</span> : null}
            {productReviews.length > 0 ? (
              <span className="flex items-center gap-1">
                <StarRating
                  value={
                    productReviews.reduce((sum, review) => sum + review.rating, 0) /
                    productReviews.length
                  }
                />
                {t("store.product.reviewCount", { count: productReviews.length })}
              </span>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap items-baseline gap-3">
            <Money value={entry.price} className="text-3xl font-black text-[var(--store-text)]" />
            {entry.onSale ? (
              <>
                <Money value={entry.listPrice} strike className="text-base" />
                <span
                  className="bg-[var(--store-accent)] px-2 py-0.5 text-[11px] font-black text-[var(--store-on-accent)]"
                  style={{ borderRadius: "var(--store-radius-button)" }}
                >
                  {t("store.product.savePercent", { percent: entry.discountPercent })}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] font-medium text-[var(--store-muted)]">{t("store.product.taxIncluded")}</p>

          <p
            className={cn(
              "mt-4 inline-block px-3 py-1.5 text-xs font-black",
              entry.inStock ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700",
            )}
            style={{ borderRadius: "var(--store-radius-button)" }}
          >
            {!product.stock_tracking_enabled
              ? t("store.product.alwaysAvailable")
              : entry.inStock
                ? available !== null && available <= 5
                  ? t("store.product.onlyLeft", { count: available })
                  : t("store.product.inStock")
                : t("store.product.outOfStock")}
          </p>

          {description ? (
            <div className="mt-5 space-y-2 text-sm leading-relaxed text-[var(--store-muted)]">
              {description
                .split(/\n{2,}/)
                .map((paragraph) => paragraph.trim())
                .filter(Boolean)
                .map((paragraph) => (
                  <p key={paragraph.slice(0, 32)}>{paragraph}</p>
                ))}
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <QuantityStepper
              value={quantity}
              onChange={setLocalQuantity}
              max={entry.inStock ? maxQuantity : 0}
            />
            <button
              type="button"
              disabled={!entry.inStock}
              onClick={() => {
                const already = lines.find((line) => line.product_id === product.id)?.quantity ?? 0;
                if (already > 0) setQuantity(product.id, already + quantity);
                else add(product, quantity);
              }}
              className="flex-1 bg-[var(--store-primary)] px-6 py-3 text-sm font-black text-[var(--store-on-primary)] transition hover:bg-[var(--store-primary-hover)] disabled:cursor-not-allowed disabled:bg-[var(--store-border)] disabled:text-[var(--store-muted)] sm:flex-none"
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {!entry.inStock
                ? t("store.product.unavailable")
                : inCart > 0
                  ? t("store.product.addToCartAgain", { count: inCart })
                  : t("store.product.addToCart")}
            </button>
            <Link
              to={entry.inStock ? "/store/checkout" : "#"}
              onClick={(event) => {
                if (!entry.inStock) {
                  event.preventDefault();
                  return;
                }
                const already = lines.find((line) => line.product_id === product.id)?.quantity ?? 0;
                if (already === 0) add(product, quantity);
              }}
              className={cn(
                "border px-5 py-3 text-sm font-black transition",
                entry.inStock
                  ? "border-[var(--store-primary)] text-[var(--store-primary)] hover:bg-[var(--store-primary-soft)]"
                  : "pointer-events-none border-[var(--store-border)] text-[var(--store-muted)]",
              )}
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {t("store.product.buyNow")}
            </Link>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void toggleWishlist(product.id)}
              aria-pressed={wished}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--store-border)] px-3 py-2 text-xs font-bold text-[var(--store-text)] transition hover:border-[var(--store-primary)]"
            >
              <span aria-hidden>{wished ? "♥" : "♡"}</span>
              {wished ? t("store.wishlist.remove") : t("store.wishlist.add")}
              {!customer ? <span className="text-[var(--store-muted)]">· {t("store.wishlist.signInHint")}</span> : null}
            </button>
            <button
              type="button"
              onClick={() => void share()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--store-border)] px-3 py-2 text-xs font-bold text-[var(--store-text)] transition hover:border-[var(--store-primary)]"
            >
              {copied ? t("store.product.linkCopied") : t("store.product.share")}
            </button>
          </div>

          {settings.delivery.enabled || settings.delivery.pickup_enabled ? (
            <dl className="mt-6 divide-y divide-[var(--store-border)] border border-[var(--store-border)] bg-[var(--store-surface)] text-sm" style={{ borderRadius: "var(--store-radius)" }}>
              {settings.delivery.enabled ? (
                <div className="flex gap-3 px-4 py-3">
                  <dt className="w-28 shrink-0 text-xs font-black uppercase tracking-wide text-[var(--store-muted)]">
                    {t("store.checkout.delivery")}
                  </dt>
                  <dd className="text-[var(--store-text)]">
                    {settings.delivery.fee > 0
                      ? t("store.footer.deliveryFee", { amount: settings.delivery.fee.toString() })
                      : t("store.cart.freeDeliveryReached")}
                    {settings.delivery.free_delivery_threshold ? (
                      <span className="ms-1 text-[var(--store-muted)]">
                        {t("store.cart.freeDeliveryAt", {
                          amount: String(settings.delivery.free_delivery_threshold),
                        })}
                      </span>
                    ) : null}
                  </dd>
                </div>
              ) : null}
              {settings.delivery.pickup_enabled ? (
                <div className="flex gap-3 px-4 py-3">
                  <dt className="w-28 shrink-0 text-xs font-black uppercase tracking-wide text-[var(--store-muted)]">
                    {t("store.checkout.pickup")}
                  </dt>
                  <dd className="text-[var(--store-text)]">
                    {pick(settings.delivery.pickup_address_ar, settings.delivery.pickup_address_en) ||
                      t("store.footer.pickupAvailable")}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          {specs.length > 0 ? (
            <div className="mt-6">
              <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
                {t("store.product.specs")}
              </h2>
              <dl className="mt-2 divide-y divide-[var(--store-border)] border border-[var(--store-border)] bg-[var(--store-surface)]" style={{ borderRadius: "var(--store-radius)" }}>
                {specs.map((spec) => (
                  <div key={spec.id} className="flex gap-3 px-4 py-2.5 text-sm">
                    <dt className="w-32 shrink-0 font-bold text-[var(--store-muted)]">
                      {pick(spec.label_ar, spec.label_en)}
                    </dt>
                    <dd className="font-semibold text-[var(--store-text)]">{pick(spec.value_ar, spec.value_en)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      </div>

      {productReviews.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-lg font-black tracking-tight text-[var(--store-text)]">
            {t("store.product.reviews")}
          </h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {productReviews.map((review) => (
              <figure
                key={review.id}
                className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4"
                style={{ borderRadius: "var(--store-radius)" }}
              >
                <StarRating value={review.rating} />
                <blockquote className="mt-2 text-sm leading-relaxed text-[var(--store-text)]">
                  “{review.body}”
                </blockquote>
                <figcaption className="mt-2 text-xs font-bold text-[var(--store-muted)]">
                  {review.author_name}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      {related.length > 0 ? (
        <section className="mt-12">
          <h2 className="mb-4 text-lg font-black tracking-tight text-[var(--store-text)]">
            {t("store.product.related")}
          </h2>
          <ProductGrid className="lg:grid-cols-4">
            {related.map((candidate) => (
              <ProductCard key={candidate.product.id} entry={candidate} compact />
            ))}
          </ProductGrid>
        </section>
      ) : null}
    </div>
  );
}
