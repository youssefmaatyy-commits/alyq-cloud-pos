/**
 * The product tile — Phase 45's minimal editorial card.
 *
 * One component for every grid on the site — homepage sections, search results,
 * related products — because a shopper who sees the same product priced two ways
 * on one screen has no way to know which is true. The card is media-first: the
 * picture (with a quiet cross-fade to a second image on hover), then a light
 * text block, then quick add. Everything display-shaped honours the settings
 * document — columns, aspect, fit, alignment, which affordances render — while
 * the price, stock and variant logic stay exactly Phase 43's.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import type { CatalogProduct } from "../../services/catalogQuery";
import { campaignBadgeText } from "../../services/badges";
import { campaignFor, colorGroupsOf, promotionUnitPrice, variantUnitPriceOf } from "../../services/pricing";
import { variantLabelOf } from "../../services/variantLabel";
import { useStoreCart } from "../../hooks/StoreCartProvider";
import { useStorefront } from "../../hooks/StorefrontProvider";
import { useStoreAccount } from "../../hooks/StoreAccountProvider";
import { Money, ProductBadges, StoreImage } from "./StorePrimitives";

const ASPECT_CLASS: Record<string, string> = {
  square: "aspect-square",
  portrait: "aspect-[3/4]",
  landscape: "aspect-[4/3]",
  tall: "aspect-[2/3]",
};

const FIT_CLASS: Record<string, string> = {
  cover: "object-cover",
  contain: "object-contain",
};

export function ProductCard({
  entry,
  priority = false,
}: {
  entry: CatalogProduct;
  /** Kept for call-site compatibility; the Phase 45 card has one density. */
  compact?: boolean;
  /** Above-the-fold cards (first grid row) load eagerly. */
  priority?: boolean;
}) {
  const { t, pick, money, lang } = useI18n();
  const { settings, campaigns, promotions, promotionTargets } = useStorefront();
  const { add } = useStoreCart();
  const { inWishlist, toggleWishlist, customer } = useStoreAccount();
  // Phase 43: a variant product quick-adds ONE combination — the panel lists
  // exactly what is on the shelf, each chip labelled and priced as itself.
  const [picking, setPicking] = useState(false);
  const [hovering, setHovering] = useState(false);

  const card = settings.product_card;
  const { product, content, price, listPrice, onSale, badges, available, inStock } = entry;

  const name = pick(product.name_ar, product.name_en);
  // The slug makes a shareable link; the id is the fallback for a product that
  // has not been given one yet, so no product is unreachable.
  const to = `/store/products/${encodeURIComponent(content?.slug?.trim() || product.id)}`;
  const badgeText = campaignBadgeText(product.id, campaigns, (arabic, english) =>
    pick(arabic, english),
  );

  // A real current automatic offer lowers the shown price — struck through,
  // with a Sale badge — exactly what checkout will charge for this product.
  // Variant-scoped offers cannot promise a card price (no combination is
  // chosen here), so they surface on the product page instead.
  const targetMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const row of promotionTargets) {
      const set = map.get(row.promotion_id) ?? new Set<string>();
      set.add(`${row.target_kind}:${row.target_id}`);
      map.set(row.promotion_id, set);
    }
    return map;
  }, [promotionTargets]);
  const promo = useMemo(
    () =>
      promotionUnitPrice(
        product.id,
        null,
        product.category_id,
        price,
        promotions,
        targetMap,
      ),
    [price, product.category_id, product.id, promotions, targetMap],
  );
  const promoPrice = promo.promotionId !== null && promo.unit < price ? promo.unit : null;
  const cardBadges = promoPrice !== null && !badges.includes("sale") ? [...badges, "sale" as const] : badges;

  const stockLine = !product.stock_tracking_enabled
    ? t("store.product.alwaysAvailable")
    : available === null
      ? ""
      : available <= 0
        ? t("store.product.outOfStock")
        : available <= 5
          ? t("store.product.onlyLeft", { count: available })
          : t("store.product.inStock");

  const wished = inWishlist(product.id);

  const quickAdd = (variantId: string) => {
    const variant = entry.variants.find((candidate) => candidate.id === variantId);
    if (!variant) return;
    if (add(product, 1, variant)) setPicking(false);
  };

  // Media: the product's own picture; the second uploaded image cross-fades on
  // hover (a fashion-catalogue gesture, disabled on touch where hover lies).
  const primarySrc = product.image_url ?? product.images[0] ?? content?.media?.[0]?.url ?? null;
  const hoverSrc = content?.media && content.media.length > 1 ? content.media[1].url : null;
  // Colour indication: one dot per colour actually on the shelf.
  const swatches = card.show_swatches && entry.needsVariantChoice ? colorGroupsOf(entry.variants) : [];
  const brand = entry.brand.trim();

  const align =
    card.text_align === "center" ? "items-center text-center" : "items-start text-start";

  return (
    <article
      className="group flex h-full flex-col"
      data-testid={`product-card-${product.id}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <Link
        to={to}
        className="relative block overflow-hidden bg-[var(--store-surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--store-text-primary)]"
        style={{ borderRadius: "var(--store-radius)" }}
        aria-label={name}
      >
        <div className={cn("relative w-full", ASPECT_CLASS[card.aspect] ?? ASPECT_CLASS.portrait)}>
          <StoreImage
            src={primarySrc}
            alt={name}
            ratio=""
            priority={priority}
            className={cn(
              "absolute inset-0 h-full w-full transition-opacity duration-500",
              FIT_CLASS[card.image_fit] ?? "object-cover",
              hoverSrc && hovering ? "opacity-0" : "opacity-100",
            )}
          />
          {hoverSrc ? (
            <StoreImage
              src={hoverSrc}
              alt=""
              ratio=""
              className={cn(
                "absolute inset-0 h-full w-full transition-opacity duration-500",
                FIT_CLASS[card.image_fit] ?? "object-cover",
                hovering ? "opacity-100" : "opacity-0",
              )}
            />
          ) : null}
        </div>

        {/* badges — only the kinds the settings document still allows */}
        {card.show_badge && cardBadges.length > 0 ? (
          <div className="absolute start-2 top-2">
            <ProductBadges
              badges={cardBadges.filter((badge) =>
                badge === "new"
                  ? settings.badges.show_new
                  : badge === "sale"
                    ? settings.badges.show_sale
                    : badge === "bestSeller"
                      ? settings.badges.show_best_seller
                      : settings.badges.show_limited,
              )}
              text={badgeText}
              className="flex-col items-start"
            />
          </div>
        ) : null}
      </Link>

      {/* wishlist — an overlay on the media, top-end */}
      {card.show_wishlist ? (
        <button
          type="button"
          onClick={() => void toggleWishlist(product.id)}
          aria-label={wished ? t("store.wishlist.remove") : t("store.wishlist.add")}
          aria-pressed={wished}
          title={customer ? undefined : t("store.wishlist.signInHint")}
          data-testid="card-wishlist"
          className={cn(
            "-mt-12 relative z-10 ms-auto grid h-11 w-11 place-items-center self-end rounded-full bg-[var(--store-surface)] shadow-sm transition",
            wished ? "text-rose-500" : "text-[var(--store-text-secondary)] hover:text-rose-500",
          )}
          style={{ insetInlineEnd: "0.5rem" }}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
            <path
              fill={wished ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.8"
              d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 0 1 19.4 13L12 20.3Z"
            />
          </svg>
        </button>
      ) : null}

      <div className={cn("mt-1.5 flex flex-1 flex-col gap-1", align)}>
        {brand ? (
          <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--store-text-secondary)]">{brand}</p>
        ) : null}

        <h3 className="line-clamp-2 text-[13px] font-semibold leading-snug text-[var(--store-text-primary)]">
          <Link to={to} className="transition hover:text-[var(--store-accent)]">
            {name}
          </Link>
        </h3>

        {card.show_price ? (
          <div className="mt-auto w-full pt-0.5">
            {/* A variant product prices from its cheapest combination: "From"
                when the combinations disagree, one price when they do not. */}
            {entry.needsVariantChoice && entry.priceFrom !== null && entry.priceFrom !== price ? (
              <p className="flex flex-wrap items-baseline gap-1">
                <span className="text-[9px] font-bold uppercase tracking-wide text-[var(--store-text-secondary)]">
                  {t("store.variants.from")}
                </span>
                <Money value={entry.priceFrom} className="text-sm font-extrabold text-[var(--store-text-primary)]" />
              </p>
            ) : (
              <p className="flex flex-wrap items-baseline gap-1.5" data-testid="card-price">
                <Money
                  value={promoPrice ?? price}
                  className="text-sm font-extrabold text-[var(--store-text-primary)]"
                />
                {promoPrice !== null ? (
                  <Money value={price} strike className="text-[11px]" />
                ) : onSale ? (
                  <Money value={listPrice} strike className="text-[11px]" />
                ) : null}
              </p>
            )}
            <p
              className={cn(
                "mt-0.5 text-[10px] font-semibold",
                inStock ? "text-[var(--store-text-secondary)]" : "text-[var(--store-text-secondary)]",
              )}
            >
              {stockLine}
            </p>
          </div>
        ) : null}

        {swatches.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1 pt-0.5" aria-hidden>
            {swatches.map((group) => (
              <span
                key={group.color_key}
                title={pick(group.color_ar ?? "", group.color_en ?? "")}
                className="h-3 w-3 rounded-full border border-[var(--store-hairline)]"
                style={{ backgroundColor: group.color_hex ?? "transparent" }}
              />
            ))}
          </div>
        ) : null}
      </div>

      {/* quick add */}
      {card.show_quick_add ? (
        <div className="mt-2">
          {entry.needsVariantChoice ? (
            <button
              type="button"
              onClick={() => setPicking((open) => !open)}
              disabled={!inStock}
              data-testid="card-quick-add"
              className={cn(
                "min-h-11 w-full border px-3 py-2 text-[11px] font-bold tracking-wide transition disabled:cursor-not-allowed",
                inStock
                  ? "border-[var(--store-hairline)] bg-transparent text-[var(--store-text-primary)] hover:border-[var(--store-primary)] hover:bg-[var(--store-primary)] hover:text-[var(--store-on-primary)]"
                  : "border-[var(--store-border)] bg-transparent text-[var(--store-text-secondary)]",
              )}
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {t("store.variants.quickAdd")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void add(product)}
              disabled={!inStock}
              data-testid="card-add"
              className={cn(
                "min-h-11 w-full border px-3 py-2 text-[11px] font-bold tracking-wide transition disabled:cursor-not-allowed",
                inStock
                  ? "border-[var(--store-hairline)] bg-transparent text-[var(--store-text-primary)] hover:border-[var(--store-primary)] hover:bg-[var(--store-primary)] hover:text-[var(--store-on-primary)]"
                  : "border-[var(--store-border)] bg-transparent text-[var(--store-text-secondary)]",
              )}
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {inStock ? t("store.product.addToCart") : t("store.product.unavailable")}
            </button>
          )}

          {/* The quick-add panel: every combination actually on the shelf, one
              chip each, priced as itself. Nothing hidden, nothing guessed — one
              more click than a plain product, because a colour and a size are a
              decision only the customer can make. */}
          {entry.needsVariantChoice && picking && inStock ? (
            <div
              className="mt-2 border border-[var(--store-hairline)] bg-[var(--store-surface)] p-2"
              style={{ borderRadius: "var(--store-radius)" }}
              data-testid="card-quick-add-panel"
            >
              <p className="mb-1.5 text-[9px] font-black uppercase tracking-[0.18em] text-[var(--store-text-secondary)]">
                {t("store.variants.pickShelf")}
              </p>
              <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                {entry.variants.map((variant) => {
                  const variantPrice = variantUnitPriceOf(
                    variant,
                    product.selling_price,
                    campaignFor(product.id, campaigns),
                  );
                  // An empty shelf is a disabled chip, not a click that goes
                  // nowhere: dimmed, struck through, and named as sold out.
                  const soldOut = variant.stock_quantity <= 0;
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      data-testid={`quick-add-${variantLabelOf(variant, "en")}`}
                      title={soldOut ? t("store.product.outOfStock") : variantLabelOf(variant, lang)}
                      disabled={soldOut}
                      onClick={() => quickAdd(variant.id)}
                      className={`min-h-11 border px-2 py-1 text-[11px] font-bold transition ${
                        soldOut
                          ? "cursor-not-allowed border-[var(--store-border)] text-[var(--store-text-secondary)] line-through opacity-50"
                          : "border-[var(--store-hairline)] text-[var(--store-text-primary)] hover:border-[var(--store-primary)] hover:text-[var(--store-primary)]"
                      }`}
                      style={{ borderRadius: "var(--store-radius-button)" }}
                    >
                      {variantLabelOf(variant, lang)}
                      <span className="ms-1 font-semibold opacity-70">
                        {money(variantPrice)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <Link
                to={to}
                className="mt-1.5 inline-block text-[10px] font-bold text-[var(--store-primary)] hover:underline"
              >
                {t("store.variants.seeDetails")}
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** The responsive grid every product rail uses — settings-driven columns. */
export function ProductGrid({
  children,
  className,
  overrideColumns,
}: {
  children: React.ReactNode;
  className?: string;
  overrideColumns?: { mobile: number; desktop: number };
}) {
  const { settings } = useStorefront();
  const columns = overrideColumns ?? { mobile: settings.product_card.mobile_columns, desktop: settings.product_card.desktop_columns };
  // Literal class maps so Tailwind's scanner sees every candidate once.
  const MOBILE = ["grid-cols-1", "grid-cols-1", "grid-cols-2", "grid-cols-3"] as const;
  const DESKTOP = [
    "lg:grid-cols-2",
    "lg:grid-cols-2",
    "lg:grid-cols-2",
    "lg:grid-cols-3",
    "lg:grid-cols-4",
    "lg:grid-cols-5",
    "lg:grid-cols-6",
  ] as const;
  const mobileClass = MOBILE[Math.min(3, Math.max(1, columns.mobile))];
  const desktopClass = DESKTOP[Math.min(6, Math.max(2, columns.desktop))];
  return (
    <div
      className={cn("grid gap-x-3 gap-y-7 sm:gap-x-4", mobileClass, desktopClass, className)}
      data-testid="product-grid"
    >
      {children}
    </div>
  );
}
