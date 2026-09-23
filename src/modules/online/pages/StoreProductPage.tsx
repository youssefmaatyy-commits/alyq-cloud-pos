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
  campaignFor,
  colorGroupsOf,
  promotionUnitPrice,
  variantUnitPriceOf,
  type StoreVariant,
} from "../services/pricing";
import { variantAvailableToPromise } from "../services/availability";
import { variantLabelOf } from "../services/variantLabel";
import { productContentSections } from "../types";
import { VariantPicker } from "../components/storefront/VariantPicker";
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
import { rememberViewed } from "../services/shopperMemory";

/** How far the zoomed image follows the pointer. */
const ZOOM = 2;

/**
 * The Phase 45 content accordions: the short pitch plus every editorial field
 * the admin wrote, collapsed by default (the first stays open so a product is
 * never a wall of closed drawers). Text nodes only — product content renders as
 * text, never as markup.
 */
function ContentAccordions({
  shortDescription,
  sections,
  firstOpen = false,
}: {
  shortDescription: string;
  sections: ReturnType<typeof productContentSections>;
  firstOpen?: boolean;
}) {
  const { pick } = useI18n();
  const [open, setOpen] = useState<string | null>(firstOpen ? "description" : null);

  const rows: { key: string; title: string; body: string }[] = [
    ...sections.map((section) => ({
      key: section.key,
      title: pick(section.title_ar, section.title_en),
      body: pick(section.body_ar, section.body_en),
    })),
  ];
  if (rows.length === 0 && !shortDescription) return null;

  return (
    <div className="mt-5">
      {shortDescription && shortDescription !== "—" ? (
        <p className="text-sm font-medium leading-relaxed text-[var(--store-text-primary)]">{shortDescription}</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="mt-3 divide-y divide-[var(--store-hairline)] border-y border-[var(--store-hairline)]">
          {rows.map((row) => {
            const isOpen = open === row.key;
            return (
              <div key={row.key}>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : row.key)}
                  aria-expanded={isOpen}
                  data-testid={`product-content-${row.key}`}
                  className="flex w-full items-center justify-between gap-3 py-3 text-start text-[11px] font-black uppercase tracking-[0.18em] text-[var(--store-text-primary)]"
                >
                  {row.title}
                  <span
                    aria-hidden
                    className={cn("text-[var(--store-text-secondary)] transition-transform", isOpen && "rotate-45")}
                  >
                    +
                  </span>
                </button>
                {isOpen ? (
                  <div className="space-y-2 pb-4 text-sm leading-relaxed text-[var(--store-text-secondary)]">
                    {row.body
                      .split(/\n{2,}/)
                      .map((paragraph) => paragraph.trim())
                      .filter(Boolean)
                      .map((paragraph) => (
                        <p key={paragraph.slice(0, 32)}>{paragraph}</p>
                      ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

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
    promotions,
    promotionTargets,
    reviews,
    settings,
    variantsOf,
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

  // ── the combination (Phase 43) ────────────────────────────────────────────
  // Published combinations of this product, display order; the picker starts
  // with NOTHING selected, because a silent default is the web's version of
  // the register picking a colour for the cashier — the customer says which
  // one they want, and the label follows them into the cart.
  const publishedVariants = useMemo(
    () => (product ? variantsOf(product.id) : []),
    [product, variantsOf],
  );
  const colorGroups = useMemo(() => colorGroupsOf(publishedVariants), [publishedVariants]);
  const [chosenColorKey, setChosenColorKey] = useState<string | null>(null);
  const [chosenVariantId, setChosenVariantId] = useState<string | null>(null);

  // A different product routed in resets the choice, not the page.
  useEffect(() => {
    setChosenColorKey(null);
    setChosenVariantId(null);
    setLocalQuantity(1);
    setImageIndex(0);
  }, [product?.id]);

  const chosenVariant = useMemo(
    () => publishedVariants.find((variant) => variant.id === chosenVariantId) ?? null,
    [chosenVariantId, publishedVariants],
  );

  /** Available-to-promise of one combination (its own holds subtracted). */
  const variantAvailable = useCallback(
    (variant: StoreVariant) =>
      product?.stock_tracking_enabled
        ? variantAvailableToPromise(variant, catalogContext.reservedVariant?.get(variant.id) ?? 0)
        : null,
    [catalogContext.reservedVariant, product],
  );

  const pickColor = (colorKey: string) => {
    setChosenColorKey(colorKey);
    // The size of a colour just opened falls back to unselected: the customer
    // re-chooses rather than inheriting the previous colour's size.
    const group = colorGroups.find((candidate) => candidate.color_key === colorKey) ?? null;
    const stillValid = group?.variants.some((variant) => variant.id === chosenVariantId) ?? false;
    if (!stillValid) setChosenVariantId(null);
  };

  const selectVariant = (variant: StoreVariant) => {
    setChosenColorKey(variant.color_key);
    setChosenVariantId(variant.id);
  };

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

  // What THIS shelf promises. A variant product answers from the chosen
  // combination — its own stock minus its own holds — and refuses to sell
  // before one is chosen; a plain product answers from the rollup, exactly as
  // it always has.
  const needsChoice = entry?.needsVariantChoice ?? false;
  const shelfPrice =
    chosenVariant && product
      ? variantUnitPriceOf(chosenVariant, product.selling_price, campaignFor(product.id, campaigns))
      : (entry?.price ?? 0);

  // A real current automatic offer on the chosen shelf — struck through, with
  // the sale badge — exactly what checkout will charge for it. Variant-scoped
  // offers resolve here (the combination IS chosen), store/category/product
  // scopes resolve on the card too. Above the early return: hooks first.
  const promoTargets = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const row of promotionTargets) {
      const set = map.get(row.promotion_id) ?? new Set<string>();
      set.add(`${row.target_kind}:${row.target_id}`);
      map.set(row.promotion_id, set);
    }
    return map;
  }, [promotionTargets]);
  const shelfPromo = useMemo(
    () =>
      product
        ? promotionUnitPrice(
            product.id,
            chosenVariant?.id ?? null,
            product.category_id,
            shelfPrice,
            promotions,
            promoTargets,
          )
        : { unit: shelfPrice, promotionId: null },
    [chosenVariant?.id, product, promotions, promoTargets, shelfPrice],
  );
  const promoShelfPrice =
    shelfPromo.promotionId !== null && shelfPromo.unit < shelfPrice ? shelfPromo.unit : null;

  const gallery = useMemo(() => {
    if (!product) return [] as string[];
    const base = [product.image_url, ...product.images].filter(
      (url): url is string => Boolean(url && url.trim()),
    );
    // Phase 45: the product-content gallery (uploads with real alt text) joins
    // the queue after the catalogue images, in the admin's order.
    const media = [...(content?.media ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => item.url.trim())
      .filter(Boolean);
    return [...base, ...media.filter((url) => !base.includes(url))];
  }, [content, product]);

  // Alt text per gallery image where the admin wrote one (content media).
  const altOf = useCallback(
    (url: string) => {
      const item = content?.media?.find((candidate) => candidate.url === url);
      return (item ? pick(item.alt_ar, item.alt_en) : "").trim() || pick(product?.name_ar, product?.name_en) || "";
    },
    [content, product, pick],
  );

  const category = product?.category_id
    ? categories.find((candidate) => candidate.id === product.category_id) ?? null
    : null;

  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    if (!product) return;
    setRecentIds(rememberViewed(product.id));
  }, [product]);

  const related = useMemo(
    () => (product ? relatedProducts(product, products, catalogContext, 4) : []),
    [catalogContext, product, products],
  );
  const recentlyViewed = useMemo(() => {
    const entries = searchCatalog(products, { ...EMPTY_CATALOG_FILTERS, productIds: recentIds, sort: "featured" }, catalogContext);
    return recentIds.map((id) => entries.find((entry) => entry.product.id === id && entry.product.id !== product?.id)).filter(Boolean).slice(0, 4) as typeof entries;
  }, [catalogContext, product?.id, products, recentIds]);

  const productReviews = useMemo(
    () => (product ? reviews.filter((review) => review.product_id === product.id && review.visible) : []),
    [product, reviews],
  );

  // Phase 43: "already in the cart" is asked of THIS combination's line, not of
  // the product — Gold / 17 in the cart says nothing about Silver / 17.
  const inCart = product
    ? lines.find(
        (line) =>
          line.product_id === product.id && (line.variant_id ?? null) === (chosenVariant?.id ?? null),
      )?.quantity ?? 0
    : 0;

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
        <p className="text-lg font-black text-[var(--store-text-primary)]">{t("common.notFound")}</p>
        <p className="mt-2 text-sm text-[var(--store-text-secondary)]">{t("store.product.notFoundHint")}</p>
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
  const specs = content?.specs ?? [];
  const brand = (content?.brand_ar || content?.brand_en) ? pick(content.brand_ar, content.brand_en) : "";
  const badgeText = campaignBadgeText(product.id, campaigns, (arabic, english) => pick(arabic, english));
  const wished = inWishlist(product.id);
  const shelfAvailable = chosenVariant ? variantAvailable(chosenVariant) : entry.available;
  const shelfInStock = needsChoice
    ? chosenVariant !== null && (shelfAvailable === null || shelfAvailable > 0)
    : entry.inStock;
  const maxQuantity =
    shelfAvailable === null ? 99 : Math.max(shelfAvailable, 0);

  const addToCart = () => {
    if (needsChoice && !chosenVariant) return;
    if (!shelfInStock) return;
    const already = lines.find(
      (line) =>
        line.product_id === product.id &&
        (line.variant_id ?? null) === (chosenVariant?.id ?? null),
    )?.quantity ?? 0;
    if (already > 0) {
      setQuantity(product.id, chosenVariant?.id ?? null, Math.min(already + quantity, maxQuantity));
    } else {
      add(product, quantity, chosenVariant);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[var(--store-max-width,72rem)] px-4 py-6 sm:px-6">
      <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[var(--store-text-secondary)]" aria-label={t("store.product.breadcrumb")}>
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
        <span className="truncate text-[var(--store-text-primary)]">{name}</span>
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
              src={chosenVariant?.image_url ?? gallery[imageIndex] ?? null}
              alt={chosenVariant?.image_url ? `${name} — ${variantLabelOf(chosenVariant, lang)}` : name}
              ratio="aspect-square"
              priority
              sizes="(max-width: 1024px) 100vw, 50vw"
              style={
                zoom
                  ? { transform: `scale(${ZOOM})`, transformOrigin: `${zoom.x}% ${zoom.y}%`, transition: "transform 80ms linear" }
                  : undefined
              }
            />
            {entry.badges.length > 0 || promoShelfPrice !== null ? (
              <ProductBadges
                badges={(promoShelfPrice !== null && !entry.badges.includes("sale")
                  ? [...entry.badges, "sale" as const]
                  : entry.badges
                ).filter((badge) =>
                  badge === "new"
                    ? settings.badges.show_new
                    : badge === "sale"
                      ? settings.badges.show_sale
                      : badge === "bestSeller"
                        ? settings.badges.show_best_seller
                        : settings.badges.show_limited,
                )}
                text={badgeText}
                className="absolute top-3 p-0"
              />
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
                  <img src={url} alt={altOf(url)} aria-hidden loading="lazy" decoding="async" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          ) : null}
          {gallery.length > 0 ? (
            <p className="mt-2 text-[11px] font-medium text-[var(--store-text-secondary)]">{t("store.product.zoomHint")}</p>
          ) : null}
        </div>

        <div className="lg:sticky lg:top-28 lg:self-start">
          {brand ? (
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[var(--store-text-secondary)]">{brand}</p>
          ) : null}
          <h1 style={{ fontFamily: "var(--store-font-display)" }} className="mt-1 text-3xl font-normal leading-tight tracking-tight text-[var(--store-text-primary)] sm:text-4xl">
            {name}
          </h1>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-semibold text-[var(--store-text-secondary)]">
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
            <span data-testid="product-price">
              <Money
                value={promoShelfPrice ?? shelfPrice}
                className="text-2xl font-medium text-[var(--store-text-primary)]"
              />
            </span>
            {promoShelfPrice !== null ? (
              <Money value={shelfPrice} strike className="text-base" />
            ) : chosenVariant === null && entry.onSale ? (
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
          <p className="mt-1 text-[11px] font-medium text-[var(--store-text-secondary)]">{t("store.product.taxIncluded")}</p>

          {/* The combination's own selector, before any buying control: colour
              first, then that colour's NUMERIC sizes (16 → 16.5 → 17), each
              showing exactly what its shelf holds. Sold out stays visible but
              unbuyable — a customer should see the shop ran out, not that the
              option quietly vanished. */}
          {needsChoice ? (
            <VariantPicker
              groups={colorGroups}
              chosenColorKey={chosenColorKey}
              chosenVariantId={chosenVariantId}
              availableOf={variantAvailable}
              onColor={pickColor}
              onVariant={selectVariant}
            />
          ) : null}

          <p
            className={cn(
              "mt-4 inline-block px-3 py-1.5 text-xs font-black",
              shelfInStock ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700",
            )}
            style={{ borderRadius: "var(--store-radius-button)" }}
            data-testid="product-stock-line"
          >
            {!product.stock_tracking_enabled
              ? t("store.product.alwaysAvailable")
              : !shelfInStock
                ? needsChoice && !chosenVariant
                  ? t("store.variants.choosePrompt")
                  : t("store.product.outOfStock")
                : shelfAvailable !== null && shelfAvailable <= 5
                  ? t("store.product.onlyLeft", { count: shelfAvailable })
                  : t("store.product.inStock")}
          </p>

          {/* Phase 45: the short pitch sits under the price; everything else an
              admin wrote — full description, materials, dimensions, care,
              shipping, returns, gift note — becomes a quiet accordion. */}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <QuantityStepper
              value={quantity}
              onChange={setLocalQuantity}
              max={shelfInStock ? maxQuantity : 0}
            />
            <button
              type="button"
              disabled={!shelfInStock}
              data-testid="product-add-to-cart"
              onClick={addToCart}
              className="min-h-11 min-w-40 flex-1 bg-[var(--store-primary)] px-6 py-3 text-sm font-black text-[var(--store-on-primary)] transition hover:bg-[var(--store-primary-hover)] disabled:cursor-not-allowed disabled:bg-[var(--store-border)] disabled:text-[var(--store-text-secondary)] sm:flex-none"
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {!shelfInStock
                ? needsChoice && !chosenVariant
                  ? t("store.variants.choosePrompt")
                  : t("store.product.unavailable")
                : inCart > 0
                  ? t("store.product.addToCartAgain", { count: inCart })
                  : t("store.product.addToCart")}
            </button>
            <Link
              to={shelfInStock ? "/store/checkout" : "#"}
              data-testid="product-buy-now"
              onClick={(event) => {
                if (!shelfInStock) {
                  event.preventDefault();
                  return;
                }
                const already = lines.find(
                  (line) =>
                    line.product_id === product.id &&
                    (line.variant_id ?? null) === (chosenVariant?.id ?? null),
                )?.quantity ?? 0;
                if (already === 0) add(product, quantity, chosenVariant);
              }}
              className={cn(
                "w-full border px-5 py-3 text-center text-sm font-bold transition sm:w-auto",
                shelfInStock
                  ? "border-[var(--store-primary)] text-[var(--store-primary)] hover:bg-[var(--store-primary-soft)]"
                  : "pointer-events-none border-[var(--store-border)] text-[var(--store-text-secondary)]",
              )}
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {t("store.product.buyNow")}
            </Link>
          </div>

          {chosenVariant ? (
            <p className="text-xs font-bold text-[var(--store-text-secondary)]" data-testid="product-chosen-variant">
              {t("store.variants.chosen")}:{" "}
              <span className="text-[var(--store-text-primary)]">
                {variantLabelOf(chosenVariant, lang)}
              </span>
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void toggleWishlist(product.id)}
              aria-pressed={wished}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--store-border)] px-3 py-2 text-xs font-bold text-[var(--store-text-primary)] transition hover:border-[var(--store-primary)]"
            >
              <span aria-hidden>{wished ? "♥" : "♡"}</span>
              {wished ? t("store.wishlist.remove") : t("store.wishlist.add")}
              {!customer ? <span className="text-[var(--store-text-secondary)]">· {t("store.wishlist.signInHint")}</span> : null}
            </button>
            <button
              type="button"
              onClick={() => void share()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--store-border)] px-3 py-2 text-xs font-bold text-[var(--store-text-primary)] transition hover:border-[var(--store-primary)]"
            >
              {copied ? t("store.product.linkCopied") : t("store.product.share")}
            </button>
          </div>

          {settings.delivery.enabled || settings.delivery.pickup_enabled ? (
            <dl className="mt-6 divide-y divide-[var(--store-border)] border border-[var(--store-border)] bg-[var(--store-surface)] text-sm" style={{ borderRadius: "var(--store-radius)" }}>
              {settings.delivery.enabled ? (
                <div className="flex gap-3 px-4 py-3">
                  <dt className="w-28 shrink-0 text-xs font-black uppercase tracking-wide text-[var(--store-text-secondary)]">
                    {t("store.checkout.delivery")}
                  </dt>
                  <dd className="text-[var(--store-text-primary)]">
                    {settings.delivery.fee > 0
                      ? t("store.footer.deliveryFee", { amount: settings.delivery.fee.toString() })
                      : t("store.cart.freeDeliveryReached")}
                    {settings.delivery.free_delivery_threshold ? (
                      <span className="ms-1 text-[var(--store-text-secondary)]">
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
                  <dt className="w-28 shrink-0 text-xs font-black uppercase tracking-wide text-[var(--store-text-secondary)]">
                    {t("store.checkout.pickup")}
                  </dt>
                  <dd className="text-[var(--store-text-primary)]">
                    {pick(settings.delivery.pickup_address_ar, settings.delivery.pickup_address_en) ||
                      t("store.footer.pickupAvailable")}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          <ContentAccordions
            shortDescription={pick(
              content?.short_description_ar ?? null,
              content?.short_description_en ?? null,
            ).trim()}
            sections={productContentSections(content)}
            firstOpen
          />

          {specs.length > 0 ? (
            <div className="mt-6">
              <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
                {t("store.product.specs")}
              </h2>
              <dl className="mt-2 divide-y divide-[var(--store-border)] border border-[var(--store-border)] bg-[var(--store-surface)]" style={{ borderRadius: "var(--store-radius)" }}>
                {specs.map((spec) => (
                  <div key={spec.id} className="flex gap-3 px-4 py-2.5 text-sm">
                    <dt className="w-32 shrink-0 font-bold text-[var(--store-text-secondary)]">
                      {pick(spec.label_ar, spec.label_en)}
                    </dt>
                    <dd className="font-semibold text-[var(--store-text-primary)]">{pick(spec.value_ar, spec.value_en)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      </div>

      {productReviews.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-lg font-black tracking-tight text-[var(--store-text-primary)]">
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
                <blockquote className="mt-2 text-sm leading-relaxed text-[var(--store-text-primary)]">
                  “{review.body}”
                </blockquote>
                <figcaption className="mt-2 text-xs font-bold text-[var(--store-text-secondary)]">
                  {review.author_name}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      {related.length > 0 ? (
        <section className="mt-12">
          <h2 className="mb-4 text-lg font-black tracking-tight text-[var(--store-text-primary)]">
            {t("store.product.related")}
          </h2>
          <ProductGrid className="lg:grid-cols-4">
            {related.map((candidate) => (
              <ProductCard key={candidate.product.id} entry={candidate} compact />
            ))}
          </ProductGrid>
        </section>
      ) : null}

      {recentlyViewed.length > 0 ? (
        <section className="mt-12">
          <h2 className="mb-4 text-lg font-black tracking-tight text-[var(--store-text-primary)]">{t("store.product.recentlyViewed")}</h2>
          <ProductGrid className="lg:grid-cols-4">
            {recentlyViewed.map((candidate) => <ProductCard key={candidate.product.id} entry={candidate} compact />)}
          </ProductGrid>
        </section>
      ) : null}
    </div>
  );
}
