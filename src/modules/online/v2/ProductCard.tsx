import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { variantMatchesCatalogFilters, type CatalogFilters, type CatalogProduct } from "../services/catalogQuery";
import type { StoreVariant } from "../services/pricing";
import { campaignBadgeText } from "../services/badges";
import { variantColorLabel } from "../services/variantLabel";
import { useStorefront } from "../hooks/StorefrontProvider";
import { useStoreCart } from "../hooks/StoreCartProvider";
import { useStoreAccount } from "../hooks/StoreAccountProvider";
import { V2Image, V2Status } from "./Primitives";
import { V2VariantChooser } from "./VariantChooser";
import { variantModel } from "./variantModel";
import { v2Gallery, v2Price } from "./viewModel";

export function V2ProductCard({ entry, priority = false, filters }: {
  entry: CatalogProduct; priority?: boolean;
  filters?: Pick<CatalogFilters, "color" | "size" | "sizeLabel">;
}) {
  const { pick, lang, money, t } = useI18n();
  const { variantsOf, catalogContext, settings, campaigns, promotions, promotionTargets, mode } = useStorefront();
  const { add } = useStoreCart();
  const { inWishlist, toggleWishlist } = useStoreAccount();
  const { product, content } = entry;
  const name = pick(product.name_ar, product.name_en);
  const route = `/store/products/${encodeURIComponent(content?.slug?.trim() || product.id)}`;
  const allVariants = variantsOf(product.id);
  const model = useMemo(() => variantModel(allVariants, catalogContext.reservedVariant, product.stock_tracking_enabled),
    [allVariants, catalogContext.reservedVariant, product.stock_tracking_enabled]);
  const narrowed = Boolean(filters && (filters.color || filters.size !== null || filters.sizeLabel));
  const shownVariants = narrowed && filters
    ? allVariants.filter((variant) => variantMatchesCatalogFilters(variant, filters)) : allVariants;
  const pricing = v2Price(product, shownVariants, campaigns, promotions, promotionTargets,
    null, catalogContext.reservedVariant);
  const gallery = v2Gallery(product, content);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<StoreVariant | null>(null);
  const [colorKey, setColorKey] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  // Transient "Added ✓" state on the button itself. `addLock` is the actual
  // guard against rapid repeated taps adding the item more than once while
  // that confirmation is still showing; `justAdded` only drives the label.
  const [justAdded, setJustAdded] = useState(false);
  const addLock = useRef(false);
  const justAddedTimer = useRef<number | null>(null);
  const addLockTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (justAddedTimer.current !== null) window.clearTimeout(justAddedTimer.current);
    if (addLockTimer.current !== null) window.clearTimeout(addLockTimer.current);
  }, []);
  const wished = inWishlist(product.id);
  const matchingSellable = narrowed && filters
    ? model.sellable.filter((variant) => variantMatchesCatalogFilters(variant, filters)) : model.sellable;
  const sellable = product.stock_tracking_enabled && (product.variants_enabled
    ? matchingSellable.length > 0
    : entry.available !== null && entry.available > 0);

  const badges = entry.badges.filter((badge) => badge === "new" ? settings.badges.show_new
    : badge === "sale" ? settings.badges.show_sale
      : badge === "bestSeller" ? settings.badges.show_best_seller
        : badge === "featured");
  const badge = badges[0] ?? (settings.badges.show_sale && pricing.price < pricing.list ? "sale" : null);
  const campaignBadge = campaignBadgeText(product.id, campaigns, pick);
  const limited = settings.badges.show_limited && product.stock_tracking_enabled &&
    entry.available !== null && entry.available > 0 && entry.available <= product.low_stock_level;
  const colorPreview = model.groups.find((group) => group.color_key === colorKey)
    ?.variants.find((variant) => variant.image_url)?.image_url;

  function addVariant(variant: StoreVariant | null) {
    // A short window where a second tap is simply ignored, not a second
    // add — this is what actually prevents a double-tap from adding twice;
    // `justAdded` below only controls what the button displays meanwhile.
    if (addLock.current) return;
    addLock.current = true;
    addLockTimer.current = window.setTimeout(() => { addLock.current = false; }, 900);
    if (add(product, 1, variant)) {
      setOpen(false);
      setNotice(t("store.v2.added"));
      setJustAdded(true);
      if (justAddedTimer.current !== null) window.clearTimeout(justAddedTimer.current);
      justAddedTimer.current = window.setTimeout(() => setJustAdded(false), 1400);
    } else {
      setNotice(t("store.error.insufficient_stock"));
    }
  }
  function quickAdd() {
    setNotice("");
    if (!sellable) return;
    if (!product.variants_enabled) {
      addVariant(null);
    } else if (narrowed && matchingSellable.length === 1) {
      addVariant(matchingSellable[0]);
    } else if (!narrowed && model.soleQuickAdd()) {
      addVariant(model.soleQuickAdd());
    } else {
      setOpen((value) => !value);
      setChosen(null);
    }
  }

  const cardAvailable = narrowed ? entry.available : product.variants_enabled
    ? model.sellable.reduce((sum, variant) => sum + model.remaining(variant), 0)
    : entry.available;

  return (
    <article className="v2-product-card" data-testid={`v2-card-${product.id}`}
      data-align={settings.product_card.text_align}>
      <div className="v2-product-media" data-aspect={settings.product_card.aspect}>
        <Link to={route} className="v2-product-photo" aria-label={name}>
          <V2Image src={colorPreview || gallery[0]} alt={name} priority={priority} fit={settings.product_card.image_fit} />
          {gallery[1] ? <V2Image src={gallery[1]} alt="" className="v2-photo-alt" fit={settings.product_card.image_fit} /> : null}
        </Link>
        {settings.product_card.show_badge && (badge || limited) ? (
          <span className="v2-product-badge">{badge
            ? badge === "sale" && campaignBadge ? campaignBadge : t(`store.badge.${badge}`)
            : t("store.v2.limited")}</span>
        ) : null}
        {settings.product_card.show_wishlist ? (
          <button type="button" className="v2-wishlist" data-testid="v2-wishlist" aria-pressed={wished}
            aria-label={t(wished ? "store.wishlist.remove" : "store.wishlist.add")}
            onClick={() => void toggleWishlist(product.id)}>
            <svg viewBox="0 0 24 24" aria-hidden><path d="M12 20 4.5 12.7A4.6 4.6 0 0 1 11 6.2l1 1 1-1a4.6 4.6 0 0 1 6.5 6.5L12 20Z" fill={wished ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" /></svg>
          </button>
        ) : null}
      </div>
      <div className="v2-card-meta">
        {entry.brand ? <p className="v2-card-brand">{content ? pick(content.brand_ar, content.brand_en) : entry.brand}</p> : null}
        <Link className="v2-card-name" to={route}>{name}</Link>
        {settings.product_card.show_price ? <div className="v2-card-price">
          {pricing.from ? <span className="v2-price-from">{t("store.variants.from")} </span> : null}
          <strong>{money(pricing.price)}</strong>
          {pricing.price < pricing.list ? <del>{money(pricing.list)}</del> : null}
        </div> : null}
        {settings.product_card.show_swatches && model.hasColors ? (
          <div className="v2-card-swatches" role="group" aria-label={t("store.variants.color")}>
            {model.groups.slice(0, 6).map((group) => {
              const available = group.variants.some((variant) => model.remaining(variant) > 0);
              const label = variantColorLabel(group, lang) || t("store.variants.defaultColor");
              return <button type="button" key={group.color_key} disabled={!available}
                aria-label={`${t("store.variants.color")}: ${label}${available ? "" : ` — ${t("store.variants.soldOut")}`}`}
                aria-pressed={colorKey === group.color_key}
                onClick={() => { setColorKey(group.color_key); setChosen(null); }}>
                <span className="v2-swatch" style={{ backgroundColor: group.color_hex || "transparent" }} aria-hidden />
              </button>;
            })}
          </div>
        ) : null}
        <V2Status available={cardAvailable} mode={mode} tracked={product.stock_tracking_enabled} />
        {settings.product_card.show_quick_add ? (
          <button type="button" className="v2-card-add" data-testid={`v2-quick-add-${product.id}`}
            data-added={justAdded || undefined}
            disabled={!sellable} aria-expanded={product.variants_enabled && matchingSellable.length > 1 ? open : undefined}
            onClick={quickAdd}>
            <span>{justAdded ? t("store.v2.addedShort") : !sellable ? t("store.product.unavailable")
              : product.variants_enabled && matchingSellable.length > 1
                ? t("store.v2.selectOptions") : t("store.v2.quickAdd")}</span>
            <span aria-hidden>{justAdded ? "✓" : open ? "−" : "+"}</span>
          </button>
        ) : null}
        {open && model.variants.length > 1 ? (
          <div className="v2-card-options" data-testid="v2-card-options">
            <V2VariantChooser model={model} colorKey={colorKey} variantId={chosen?.id ?? null} compact
              onChoice={(variant, key) => { setChosen(variant); setColorKey(key); }} />
            <button type="button" className="v2-solid-button" disabled={!chosen} onClick={() => addVariant(chosen)}>
              {t("store.product.addToCart")}
            </button>
          </div>
        ) : null}
        <span className="sr-only" role="status" aria-live="polite">{notice}</span>
      </div>
    </article>
  );
}
