/**
 * The product tile.
 *
 * One component for every grid on the site — homepage sections, search results,
 * related products — because a shopper who sees the same product priced two ways
 * on one screen has no way to know which is true. The tile shows the campaign
 * price with the catalogue price struck through, the badges the product has
 * earned, an honest stock line, and an add button that refuses (and says why)
 * when the unit cannot be promised.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import type { CatalogProduct } from "../../services/catalogQuery";
import { campaignBadgeText } from "../../services/badges";
import { campaignFor, variantUnitPriceOf } from "../../services/pricing";
import { variantLabelOf } from "../../services/variantLabel";
import { useStoreCart } from "../../hooks/StoreCartProvider";
import { useStorefront } from "../../hooks/StorefrontProvider";
import { useStoreAccount } from "../../hooks/StoreAccountProvider";
import { Money, ProductBadges, StoreImage } from "./StorePrimitives";

export function ProductCard({
  entry,
  compact = false,
}: {
  entry: CatalogProduct;
  /** Tighter padding and no description — for the homepage rails. */
  compact?: boolean;
}) {
  const { t, pick, money, lang } = useI18n();
  const { add } = useStoreCart();
  const { campaigns } = useStorefront();
  const { inWishlist, toggleWishlist, customer } = useStoreAccount();
  const { product, content, price, listPrice, onSale, badges, available, inStock } = entry;
  // Phase 43: a variant product quick-adds ONE combination — the panel lists
  // exactly what is on the shelf, each chip labelled and priced as itself.
  const [picking, setPicking] = useState(false);

  const name = pick(product.name_ar, product.name_en);
  // The slug makes a shareable link; the id is the fallback for a product that
  // has not been given one yet, so no product is unreachable.
  const to = `/store/products/${encodeURIComponent(content?.slug?.trim() || product.id)}`;
  const badgeText = campaignBadgeText(product.id, campaigns, (arabic, english) =>
    pick(arabic, english),
  );

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

  return (
    <article
      className="group relative flex h-full flex-col overflow-hidden border border-[var(--store-border)] bg-[var(--store-surface)] transition hover:shadow-lg"
      style={{ borderRadius: "var(--store-radius)" }}
    >
      <Link to={to} className="block">
        <StoreImage
          src={product.image_url ?? product.images[0] ?? null}
          alt={name}
          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
        />
      </Link>
      <span className="absolute top-0" style={{ insetInlineStart: 0 }}>
        <ProductBadges badges={badges} text={badgeText} className="p-2" />
      </span>

      <button
        type="button"
        onClick={() => void toggleWishlist(product.id)}
        aria-label={wished ? t("store.wishlist.remove") : t("store.wishlist.add")}
        aria-pressed={wished}
        title={customer ? undefined : t("store.wishlist.signInHint")}
        className={cn(
          "absolute top-2 grid h-8 w-8 place-items-center rounded-full bg-white/85 shadow-sm transition",
          wished ? "text-rose-500" : "text-slate-400 hover:text-rose-500",
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

      <div className={cn("flex flex-1 flex-col gap-1.5", compact ? "p-3" : "p-4")}>
        {content?.brand_en || content?.brand_ar ? (
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--store-muted)]">
            {pick(content.brand_ar, content.brand_en)}
          </p>
        ) : null}

        <h3 className="line-clamp-2 text-sm font-bold leading-snug text-[var(--store-text)]">
          <Link to={to} className="hover:text-[var(--store-primary)]">
            {name}
          </Link>
        </h3>

        {!compact && product.description_en ? (
          <p className="line-clamp-2 text-xs leading-relaxed text-[var(--store-muted)]">
            {pick(product.description_ar, product.description_en)}
          </p>
        ) : null}

        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          <div>
            {/* A variant product prices from its cheapest combination: "From"
                when the combinations disagree, one price when they do not. */}
            {entry.needsVariantChoice && entry.priceFrom !== null && entry.priceFrom !== price ? (
              <p className="flex items-baseline gap-1">
                <span className="text-[10px] font-bold uppercase text-[var(--store-muted)]">
                  {t("store.variants.from")}
                </span>
                <Money value={entry.priceFrom} className="text-base font-extrabold text-[var(--store-text)]" />
              </p>
            ) : (
              <p className="flex items-baseline gap-1.5">
                <Money value={price} className="text-base font-extrabold text-[var(--store-text)]" />
                {onSale ? <Money value={listPrice} strike className="text-xs" /> : null}
              </p>
            )}
            <p
              className={cn(
                "mt-0.5 text-[11px] font-semibold",
                inStock ? "text-emerald-600" : "text-rose-600",
              )}
            >
              {stockLine}
            </p>
          </div>

          {entry.needsVariantChoice ? (
            <button
              type="button"
              onClick={() => setPicking((open) => !open)}
              disabled={!inStock}
              data-testid="card-quick-add"
              className={cn(
                "shrink-0 px-3 py-2 text-xs font-bold text-[var(--store-on-primary)] transition disabled:cursor-not-allowed disabled:bg-[var(--store-border)] disabled:text-[var(--store-muted)]",
                inStock ? "bg-[var(--store-primary)] hover:bg-[var(--store-primary-hover)]" : "",
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
              className={cn(
                "shrink-0 px-3 py-2 text-xs font-bold text-[var(--store-on-primary)] transition disabled:cursor-not-allowed disabled:bg-[var(--store-border)] disabled:text-[var(--store-muted)]",
                inStock ? "bg-[var(--store-primary)] hover:bg-[var(--store-primary-hover)]" : "",
              )}
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {inStock ? t("store.product.addToCart") : t("store.product.unavailable")}
            </button>
          )}
        </div>

        {/* The quick-add panel: every combination actually on the shelf, one
            chip each, priced as itself. Nothing hidden, nothing guessed — one
            more click than a plain product, because a colour and a size are a
            decision only the customer can make. */}
        {entry.needsVariantChoice && picking && inStock ? (
          <div
            className="mt-2 border border-[var(--store-border)] bg-[var(--store-surface)] p-2"
            style={{ borderRadius: "var(--store-radius)" }}
            data-testid="card-quick-add-panel"
          >
            <p className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-[var(--store-muted)]">
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
                    className={`border px-2 py-1 text-[11px] font-bold transition ${
                      soldOut
                        ? "cursor-not-allowed border-[var(--store-border)] text-[var(--store-muted)] line-through opacity-50"
                        : "border-[var(--store-border)] text-[var(--store-text)] hover:border-[var(--store-primary)] hover:text-[var(--store-primary)]"
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
    </article>
  );
}

/** The responsive grid every product rail uses. */
export function ProductGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
        className,
      )}
    >
      {children}
    </div>
  );
}
