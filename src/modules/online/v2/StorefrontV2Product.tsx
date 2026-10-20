import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { useStoreCart } from "../hooks/StoreCartProvider";
import { useStoreAccount } from "../hooks/StoreAccountProvider";
import {
  findCatalogProduct, searchCatalog, EMPTY_CATALOG_FILTERS, relatedProducts,
  type CatalogProduct,
} from "../services/catalogQuery";
import {
  absoluteUrl, applyDocumentMeta, applyJsonLd, clearDocumentMeta, descriptionForProduct,
  productJsonLd, productPath, titleForProduct,
} from "../services/seo";
import { productContentSections } from "../types";
import type { Product } from "@/modules/products/types";
import type { ProductContent } from "../types";
import { V2ProductCard } from "./ProductCard";
import { V2Image, V2Price, V2ProductGrid, V2Section, V2State } from "./Primitives";
import { V2VariantChooser } from "./VariantChooser";
import { hoverZoomHandlers } from "./HoverZoom";
import { v2Price } from "./viewModel";
import { variantModel } from "./variantModel";

export function StorefrontV2Product() {
  const { t } = useI18n();
  const { key = "" } = useParams<{ key: string }>();
  const { products, contents, catalogContext, loading, error, refresh } = useStorefront();
  const product = useMemo(() => findCatalogProduct(key, products, contents), [key, products, contents]);
  const entry = useMemo(() => product
    ? searchCatalog(products, { ...EMPTY_CATALOG_FILTERS, productIds: [product.id] }, catalogContext)
      .find((candidate) => candidate.product.id === product.id) ?? null : null,
  [product, products, catalogContext]);
  useEffect(() => {
    if (entry || loading) return;
    applyDocumentMeta({ title: t("common.notFound"), description: t("store.product.notFoundHint"), noIndex: true });
    return () => clearDocumentMeta();
  }, [entry, loading, t]);
  if (loading && products.length === 0) return <V2State kind="loading" />;
  if (error && products.length === 0) return <V2State kind="error" onRetry={() => void refresh()} />;
  if (!product || !entry) return <div className="v2-container v2-not-found">
    <h1>{t("common.notFound")}</h1>
    <p>{t("store.product.notFoundHint")}</p>
    <Link to="/store/products" className="v2-outline-button">{t("store.product.browseAll")}</Link>
  </div>;
  return <V2Detail key={product.id} product={product} entry={entry} />;
}

function V2Detail({ product, entry }: { product: Product; entry: CatalogProduct }) {
  const { t, pick, lang } = useI18n();
  const { settings, contentByProduct, products, catalogContext, categories, mode,
    variantsOf, colorGalleryFor, campaigns, promotions, promotionTargets, reviews } = useStorefront();
  const { add, setQuantity, lines, notifyAdded } = useStoreCart();
  const { inWishlist, toggleWishlist } = useStoreAccount();
  const content: ProductContent | null = contentByProduct.get(product.id) ?? null;
  const variants = variantsOf(product.id);
  const model = useMemo(() => variantModel(variants, catalogContext.reservedVariant, product.stock_tracking_enabled),
    [variants, catalogContext.reservedVariant, product.stock_tracking_enabled]);
  const [color, setColor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quantity, setQuantityDraft] = useState(1);
  const [imageIndex, setImageIndex] = useState(0);
  const [zoomOpen, setZoomOpen] = useState(false);
  const openZoomButton = useRef<HTMLButtonElement>(null);
  const zoomCloseButton = useRef<HTMLButtonElement>(null);
  const sizeGuide = useRef<HTMLDetailsElement>(null);
  const [added, setAdded] = useState(false);
  // Guards the button against a rapid double tap adding the line twice while
  // the "Added ✓" confirmation is still showing; cleared with the same timer
  // that clears the confirmation itself.
  const addLock = useRef(false);
  const addedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (addedTimer.current !== null) window.clearTimeout(addedTimer.current); }, []);
  const selected = product.variants_enabled
    ? model.variants.find((variant) => variant.id === selectedId && model.remaining(variant) > 0) ?? null
    : null;
  const price = v2Price(product, variants, campaigns, promotions, promotionTargets,
    selected, catalogContext.reservedVariant);
  const badges = entry.badges.filter((badge) => badge === "new" ? settings.badges.show_new
    : badge === "sale" ? settings.badges.show_sale
      : badge === "bestSeller" ? settings.badges.show_best_seller
        : badge === "featured");
  if (settings.badges.show_sale && price.price < price.list && !badges.includes("sale")) badges.unshift("sale");
  const limited = settings.badges.show_limited && product.stock_tracking_enabled &&
    entry.available !== null && entry.available > 0 && entry.available <= product.low_stock_level;
  const category = categories.find((candidate) => candidate.id === product.category_id);
  const name = pick(product.name_ar, product.name_en);
  const gallery = useMemo(() => {
    const original = [product.image_url, ...product.images,
      ...(content?.media?.slice().sort((a, b) => a.sort_order - b.sort_order).map((item) => item.url) ?? [])]
      .filter((url): url is string => Boolean(url?.trim()));
    const colorGallery = color ? colorGalleryFor(product.id, color).map((image) => image.image_url) : [];
    const selectedModelGallery = selected
      ? [...(selected.images ?? []), selected.image_url].filter((url): url is string => Boolean(url?.trim()))
      : [];
    const allModelImages = model.hasModels
      ? model.variants.flatMap((v) => [...(v.images ?? []), v.image_url]).filter((url): url is string => Boolean(url?.trim()))
      : [];
    if (colorGallery.length) return [...new Set(colorGallery)];
    if (selectedModelGallery.length) return [...new Set([...selectedModelGallery, ...original])];
    return [...new Set([...original, ...allModelImages])];
  }, [product.id, product.image_url, product.images, content?.media, selected, color, colorGalleryFor, model.hasModels, model.variants]);
  const sections = productContentSections(content);
  const hasSizeGuide = sections.some((section) => section.key === "dimensions");
  const available = product.variants_enabled ? selected ? model.remaining(selected) : 0 : entry.available ?? 0;
  const orderable = product.stock_tracking_enabled && (product.variants_enabled ? Boolean(selected) : entry.inStock);
  const max = Math.min(99, Math.max(available, 0));
  const wished = inWishlist(product.id);
  const related = useMemo(() => relatedProducts(product, products, catalogContext, 4),
    [product, products, catalogContext]);
  const productReviews = reviews.filter((review) => review.visible && review.product_id === product.id);

  useEffect(() => setImageIndex(0), [color, selectedId]);

  useEffect(() => {
    const baseUrl = window.location.href.split("#")[0];
    const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en);
    applyDocumentMeta({
      title: titleForProduct({ name, seoTitle: content?.seo_title, storeName }),
      description: descriptionForProduct({ seoDescription: content?.seo_description,
        productDescription: pick(product.description_ar, product.description_en), fallbackName: name }),
      canonical: absoluteUrl(baseUrl, productPath(product, content)),
      ogImage: gallery[0] ?? settings.seo.og_image_url, ogType: "product",
      locale: lang === "ar" ? "ar_EG" : "en_US", siteName: storeName,
    });
    applyJsonLd(productJsonLd({ product, content,
      categoryName: category ? pick(category.name_ar, category.name_en) : null,
      price: price.price, baseUrl, storeName, pick }));
    return () => clearDocumentMeta();
  }, [category, content, gallery, lang, name, pick, price.price, product, settings.contact.store_name_ar,
    settings.contact.store_name_en, settings.seo.og_image_url]);

  useEffect(() => {
    if (!zoomOpen) return;
    const previous = document.body.style.overflow;
    const trigger = openZoomButton.current;
    document.body.style.overflow = "hidden";
    zoomCloseButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setZoomOpen(false); }
      if (event.key === "ArrowRight") setImageIndex((index) => (index + 1) % gallery.length);
      if (event.key === "ArrowLeft") setImageIndex((index) => (index + gallery.length - 1) % gallery.length);
      if (event.key === "Tab") {
        const options = [...document.querySelectorAll<HTMLElement>(".v2-lightbox button:not(:disabled)")];
        if (!options.length) return;
        if (event.shiftKey && document.activeElement === options[0]) {
          event.preventDefault(); options.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === options.at(-1)) {
          event.preventDefault(); options[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey); trigger?.focus(); };
  }, [zoomOpen, gallery.length]);

  const chooseVariant = (variant: typeof selected, colorKey: string | null) => {
    setColor(colorKey);
    setSelectedId(variant?.id ?? null);
    setImageIndex(0);
    setAdded(false);
    addLock.current = false;
    if (addedTimer.current !== null) { window.clearTimeout(addedTimer.current); addedTimer.current = null; }
  };
  const addToBag = () => {
    if (addLock.current || !orderable || (product.variants_enabled && !selected)) return;
    const already = lines.find((line) => line.product_id === product.id &&
      (line.variant_id ?? null) === (selected?.id ?? null))?.quantity ?? 0;
    const next = Math.min(already + quantity, max);
    if (next <= already) return;
    // Only ever show success once the line is actually in the cart: `add()`
    // reports it directly; the already-in-cart branch above has already
    // confirmed (via `next > already`, computed from this same render's own
    // stock figures) that the increase it is about to make is real.
    let success: boolean;
    if (already > 0) {
      setQuantity(product.id, selected?.id ?? null, next);
      notifyAdded();
      success = true;
    } else {
      success = add(product, Math.min(quantity, max), selected);
    }
    if (!success) return;
    addLock.current = true;
    setAdded(true);
    if (addedTimer.current !== null) window.clearTimeout(addedTimer.current);
    addedTimer.current = window.setTimeout(() => { setAdded(false); addLock.current = false; }, 1600);
  };

  return <div className="v2-pdp v2-container" data-testid="v2-product">
    <nav className="v2-breadcrumb" aria-label={t("store.product.breadcrumb")}>
      <Link to="/store">{t("store.nav.home")}</Link><span aria-hidden>/</span>
      <Link to="/store/products">{t("store.nav.products")}</Link>
      {category ? <><span aria-hidden>/</span><Link to={`/store/products?category=${encodeURIComponent(category.id)}`}>
        {pick(category.name_ar, category.name_en)}</Link></> : null}
      <span aria-hidden>/</span><span aria-current="page">{name}</span>
    </nav>
    <div className="v2-pdp-layout">
      <div className="v2-pdp-gallery">
        <div className="v2-pdp-main-image"><button type="button" ref={openZoomButton} className="v2-pdp-zoom"
          disabled={!gallery.length} aria-label={t("store.product.viewImage", { number: imageIndex + 1 })}
          onClick={() => setZoomOpen(true)} data-testid="v2-image-zoom"
          {...hoverZoomHandlers}>
          <V2Image src={gallery[imageIndex]} alt={name} priority /></button>
          {badges.length || limited ? <span className="v2-pdp-badges">
            {badges.slice(0, 2).map((badge) => <span key={badge} className="v2-badge">{t(`store.badge.${badge}`)}</span>)}
            {limited && badges.length < 2 ? <span className="v2-badge">{t("store.v2.limited")}</span> : null}
          </span> : null}
        </div>
        {gallery.length > 1 ? <div className="v2-pdp-thumbnails" role="group" aria-label={t("store.v2.gallery")}>
          {gallery.map((url, index) => <button key={url} type="button" className="v2-pdp-thumb"
            aria-label={t("store.product.viewImage", { number: index + 1 })} aria-pressed={imageIndex === index}
            onClick={() => setImageIndex(index)}><V2Image src={url} alt="" /></button>)}
        </div> : null}
        {gallery.length ? <p className="v2-size-note">{t("store.product.zoomHint")}</p> : null}
        {zoomOpen && gallery.length ? <div className="v2-lightbox" role="dialog" aria-modal="true"
          aria-label={t("store.v2.gallery")} data-testid="v2-lightbox">
          <button type="button" className="v2-lightbox-close" ref={zoomCloseButton}
            aria-label={t("common.close")} onClick={() => setZoomOpen(false)}>×</button>
          <div className="v2-lightbox-picture"><V2Image src={gallery[imageIndex]} alt={name} priority fit="contain" /></div>
          {gallery.length > 1 ? <div className="v2-lightbox-navigation">
            <button type="button" aria-label={t("store.product.viewImage", { number: ((imageIndex + gallery.length - 1) % gallery.length) + 1 })}
              onClick={() => setImageIndex((index) => (index + gallery.length - 1) % gallery.length)}>‹</button>
            <span aria-live="polite" dir="ltr">{imageIndex + 1} / {gallery.length}</span>
            <button type="button" aria-label={t("store.product.viewImage", { number: (imageIndex + 1) % gallery.length + 1 })}
              onClick={() => setImageIndex((index) => (index + 1) % gallery.length)}>›</button>
          </div> : null}
        </div> : null}
      </div>
      <div className="v2-pdp-info">
        <p className="v2-eyebrow">{content?.brand_ar || content?.brand_en ? pick(content.brand_ar, content.brand_en) : t("store.v2.eyebrow")}</p>
        <h1>{name}</h1>
        <p className="v2-pdp-sku">{t("store.product.sku")}: {product.sku}</p>
        <V2Price price={price} className="v2-pdp-price" />
        {product.description_ar || product.description_en ?
          <p className="v2-pdp-description">{pick(product.description_ar, product.description_en)}</p> : null}
        {product.variants_enabled ? <V2VariantChooser model={model} colorKey={color} variantId={selectedId}
          onChoice={chooseVariant} /> : null}
        {product.variants_enabled && model.hasSizes && hasSizeGuide ? <button type="button" className="v2-size-guide-link"
          onClick={() => { if (sizeGuide.current) { sizeGuide.current.open = true;
            sizeGuide.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
            sizeGuide.current.querySelector("summary")?.focus(); } }}>
          {t("store.product.content.dimensions")}</button> : null}
        <p className="v2-pdp-stock" role="status" data-testid="v2-pdp-stock">
          {!product.stock_tracking_enabled ? t("store.v2.notOrderable")
            : product.variants_enabled && !selected ? model.sellable.length ? t("store.v2.pleaseChoose") : t("store.product.outOfStock")
              : available <= 0 ? t("store.product.outOfStock")
                : model.hasModels && selected ? `${t("store.product.inStock")} · ${t("pos.variants.availableUnits", { count: available })}`
                : available <= product.low_stock_level ? mode === "demo"
                  ? t("store.product.onlyLeft", { count: available }) : t("store.v2.limited")
                  : t("store.product.inStock")}
        </p>
        <div className="v2-pdp-buy-row">
          <label className="v2-quantity">{t("store.v2.quantity")}
            <input aria-label={t("store.v2.quantity")} type="number" min="1" max={max || 1} inputMode="numeric"
              value={quantity} onChange={(event) => setQuantityDraft(Math.max(1, Math.min(max || 1, Math.floor(Number(event.target.value) || 1))))} />
          </label>
          <button type="button" className="v2-primary-button" data-added={added || undefined}
            disabled={!orderable || available <= 0}
            onClick={addToBag} data-testid="v2-pdp-add">{added ? t("store.v2.addedShort") : t("store.product.addToCart")}</button>
        </div>
        <button type="button" className="v2-pdp-wishlist" aria-pressed={wished}
          aria-label={t(wished ? "store.wishlist.remove" : "store.wishlist.add")}
          onClick={() => void toggleWishlist(product.id)}>
          <span aria-hidden>{wished ? "♥" : "♡"}</span> {t(wished ? "store.wishlist.remove" : "store.wishlist.add")}
        </button>
        {added ? <p className="v2-success" role="status">{t("store.v2.added")} · <Link to="/store/cart">{t("store.v2.bag")}</Link></p> : null}
        <p className="v2-pdp-disclaimer">{t("store.v2.stockAtCheckout")}</p>
        {content?.short_description_ar || content?.short_description_en ? <p className="v2-pdp-description">
          {pick(content.short_description_ar, content.short_description_en)}</p> : null}
        <div className="v2-pdp-details">
          {sections.map((section) => <details key={section.key} ref={section.key === "dimensions" ? sizeGuide : undefined}
            id={section.key === "dimensions" ? "v2-size-guide" : undefined}>
            <summary>{pick(section.title_ar, section.title_en)}</summary>
            <p>{pick(section.body_ar, section.body_en)}</p></details>)}
          {content?.specs?.length ? <details><summary>{t("store.product.specs")}</summary><dl>
            {content.specs.map((spec) => <div key={spec.id}><dt>{pick(spec.label_ar, spec.label_en)}</dt>
              <dd>{pick(spec.value_ar, spec.value_en)}</dd></div>)}
          </dl></details> : null}
        </div>
        {product.variants_enabled && model.hasSizes && !hasSizeGuide
          ? <p className="v2-size-note">{t("store.v2.noSizeGuide")}</p> : null}
      </div>
    </div>
    {productReviews.length ? <V2Section title={t("store.product.reviews")}> <div className="v2-review-grid">
      {productReviews.map((review) => <blockquote key={review.id}>
        <span aria-label={`${review.rating}/5`}>{"★".repeat(Math.max(0, Math.min(5, Math.round(review.rating))))}</span>
        <p>{review.body}</p><cite>{review.author_name}</cite>
      </blockquote>)}
    </div></V2Section> : null}
    {related.length ? <V2Section title={t("store.product.related")} action={<Link className="v2-text-link" to="/store/products">{t("store.v2.viewAll")}</Link>}>
      <V2ProductGrid>{related.map((item) => <V2ProductCard key={item.product.id} entry={item} />)}</V2ProductGrid>
    </V2Section> : null}
  </div>;
}
