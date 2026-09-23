/**
 * Storefront primitives.
 *
 * Small, unopinionated pieces the shop pages share, so a product tile on the
 * homepage and one in a search result are the same component and cannot drift
 * apart. Everything here reads its colours from the `--store-*` variables the
 * theme provider writes, which is what makes the admin's branding apply to the
 * whole site without a rebuild.
 *
 * Images are lazy-loaded and decoded asynchronously, and every one of them has a
 * fallback: a shop with a missing photo should show a tidy placeholder, not a
 * broken-image icon in the middle of a product grid.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import type { ProductBadge } from "../../services/badges";
import { badgeStyle } from "../../services/theme";
import type { OnlineOrderStatus, OnlinePaymentStatus } from "../../types";

/** A product image with a placeholder behind it and lazy loading in front. */
export function StoreImage({
  src,
  alt,
  className,
  ratio = "aspect-square",
  sizes = "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw",
  priority = false,
  style,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  ratio?: string;
  sizes?: string;
  priority?: boolean;
  style?: CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const show = src && !failed;

  return (
    <div className={cn("relative overflow-hidden bg-[var(--store-surface-alt)]", ratio, className)} style={style}>
      {show ? (
        <img
          src={src}
          alt={alt}
          className="h-full w-full object-cover"
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          sizes={sizes}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center" aria-hidden>
          <svg viewBox="0 0 24 24" className="h-1/4 w-1/4 text-[var(--store-muted)] opacity-40">
            <path
              fill="currentColor"
              d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm1 2v8.6l3.6-3.6a1 1 0 0 1 1.4 0L14 16.2l1.6-1.6a1 1 0 0 1 1.4 0l1 1V7H5Zm3 1.8a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z"
            />
          </svg>
        </div>
      )}
    </div>
  );
}

/** The badge pills: New / Sale / Best seller / Featured. */
export function ProductBadges({
  badges,
  text,
  className,
}: {
  badges: readonly ProductBadge[];
  /** Campaign badge text the admin wrote, shown instead of the generic "Sale". */
  text?: string | null;
  className?: string;
}) {
  const { t } = useI18n();
  if (badges.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {badges.map((badge) => (
        <span
          key={badge}
          className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          style={badgeStyle(badge)}
        >
          {badge === "sale" && text ? text : t(`store.badge.${badge}` as never)}
        </span>
      ))}
    </div>
  );
}

/** Stars, read-only — a review's rating or a filter's minimum. */
export function StarRating({
  value,
  size = 14,
  label,
}: {
  value: number;
  size?: number;
  label?: string;
}) {
  const rounded = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span
      className="inline-flex items-center gap-0.5"
      role="img"
      aria-label={label ?? `${rounded}/5`}
    >
      {[0, 1, 2, 3, 4].map((index) => (
        <svg
          key={index}
          viewBox="0 0 24 24"
          width={size}
          height={size}
          aria-hidden
          className={index < rounded ? "text-[var(--store-accent)]" : "text-[var(--store-border)]"}
        >
          <path
            fill="currentColor"
            d="m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.4l6.5-.9L12 2.6Z"
          />
        </svg>
      ))}
    </span>
  );
}

/** − 1 + with a ceiling, so a customer cannot add what is not there. */
export function QuantityStepper({
  value,
  onChange,
  max,
  size = "md",
}: {
  value: number;
  onChange: (next: number) => void;
  max?: number | null;
  size?: "sm" | "md";
}) {
  const { t } = useI18n();
  const atMax = typeof max === "number" && value >= max;
  const pad = size === "sm" ? "h-11 w-11 text-sm sm:h-8 sm:w-8" : "h-11 w-11";
  return (
    <div
      className="inline-flex items-center gap-1 border border-[var(--store-border)] bg-[var(--store-surface)]"
      style={{ borderRadius: "var(--store-radius-button)" }}
    >
      <button
        type="button"
        onClick={() => onChange(Math.max(1, value - 1))}
        disabled={value <= 1}
        aria-label={t("store.cart.decrease")}
        className={cn(
          pad,
          "grid place-items-center font-bold text-[var(--store-muted)] transition disabled:opacity-40",
        )}
      >
        −
      </button>
      <span className="min-w-8 text-center text-sm font-bold tabular-nums text-[var(--store-text)]">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        disabled={atMax}
        aria-label={t("store.cart.increase")}
        className={cn(
          pad,
          "grid place-items-center font-bold text-[var(--store-primary)] transition disabled:opacity-40",
        )}
      >
        +
      </button>
    </div>
  );
}

/** Order status pill — where the goods are. */
export function OrderStatusPill({ status }: { status: OnlineOrderStatus }) {
  const { t } = useI18n();
  const tone: Record<OnlineOrderStatus, string> = {
    pending: "bg-amber-100 text-amber-800",
    approved: "bg-sky-100 text-sky-800",
    processing: "bg-indigo-100 text-indigo-800",
    ready: "bg-violet-100 text-violet-800",
    completed: "bg-emerald-100 text-emerald-800",
    cancelled: "bg-rose-100 text-rose-800",
  };
  return (
    <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold", tone[status])}>
      {t(`online.status.${status}` as never)}
    </span>
  );
}

/**
 * Payment status pill — where the money is.
 *
 * Shown next to the order status, never merged with it: "ready for delivery,
 * payment pending" is a normal state for cash on delivery, and a single pill
 * could not say it.
 */
export function PaymentStatusPill({ status }: { status: OnlinePaymentStatus }) {
  const { t } = useI18n();
  const tone: Record<OnlinePaymentStatus, string> = {
    pending: "bg-slate-100 text-slate-700",
    paid: "bg-emerald-100 text-emerald-800",
    failed: "bg-rose-100 text-rose-800",
    verification_required: "bg-amber-100 text-amber-800",
  };
  return (
    <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold", tone[status])}>
      {t(`online.paymentStatus.${status}` as never)}
    </span>
  );
}

/** A section heading with the admin's title, or the dictionary fallback. */
export function SectionShell({
  title,
  action,
  image,
  children,
  className,
  id,
}: {
  title: string;
  action?: ReactNode;
  /** Optional band image the admin attached to this section. */
  image?: string | null;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("relative", className)}>
      {image ? (
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-cover bg-center opacity-10"
          style={{ backgroundImage: `url(${image})` }}
        />
      ) : null}
      <div className="mx-auto w-full max-w-[var(--store-max-width,72rem)] px-4 py-10 sm:px-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <h2 style={{ fontFamily: "var(--store-font-display)" }} className="text-2xl font-normal tracking-tight text-[var(--store-text)] sm:text-3xl">
            {title}
          </h2>
          {action}
        </div>
        {children}
      </div>
    </section>
  );
}

/** Small note under a field — a hint, a warning, or the reason something failed. */
export function FieldNote({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "error" | "success";
  children: ReactNode;
}) {
  const color =
    tone === "error"
      ? "text-rose-600"
      : tone === "success"
        ? "text-emerald-600"
        : "text-[var(--store-muted)]";
  return <p className={cn("mt-1 text-xs font-medium", color)}>{children}</p>;
}

/** Money, in the shop's one currency, formatted for the active language. */
export function Money({
  value,
  className,
  strike = false,
}: {
  value: number;
  className?: string;
  strike?: boolean;
}) {
  const { money } = useI18n();
  return (
    <span
      className={cn("tabular-nums", strike && "line-through opacity-60", className)}
      // A currency that never changes does not need a code beside every number;
      // `money()` already localises the digits and the symbol.
    >
      {money(value)}
    </span>
  );
}

/** A link-shaped button, for "see all" and "keep browsing". */
export function StoreLink({
  href,
  children,
  className,
  onClick,
}: {
  href?: string;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const shared = cn(
    "inline-flex items-center gap-1 text-sm font-bold text-[var(--store-primary)] underline-offset-4 hover:underline",
    className,
  );
  if (href) {
    return (
      <a href={href} className={shared} onClick={onClick}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={shared} onClick={onClick}>
      {children}
    </button>
  );
}

/** The free-delivery bar: how much more to spend to save the fee. */
export function FreeDeliveryBar({
  eligible,
  remaining,
  threshold,
}: {
  eligible: boolean;
  remaining: number;
  threshold: number;
}) {
  const { t, money } = useI18n();
  const percent = Math.max(0, Math.min(100, ((threshold - remaining) / threshold) * 100));
  return (
    <div className="rounded-xl border border-[var(--store-border)] bg-[var(--store-primary-soft)] p-3">
      <p className="text-xs font-bold text-[var(--store-primary)]">
        {eligible
          ? t("store.cart.freeDeliveryReached")
          : t("store.cart.freeDeliveryRemaining", { amount: money(remaining) })}
      </p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/60">
        <div
          className="h-full rounded-full bg-[var(--store-primary)] transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      {!eligible ? (
        <p className="mt-1.5 text-[11px] font-medium text-[var(--store-muted)]">
          {t("store.cart.freeDeliveryAt", { amount: money(threshold) })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The money block of an order: subtotal, any discount, any delivery fee, total.
 *
 * One component, two screens — the confirmation a shopper lands on after
 * checkout, and the tracking page they return to with an order number and a
 * phone. Both showed these same five rows because the markup had been copied,
 * and a copy is a promise that the next change gets made twice: a currency fix,
 * an RTL fix or a new fee line would have to be remembered in both places, and
 * the day it is not, the two screens quote the customer different totals for the
 * same order.
 *
 * It takes the money fields rather than the whole order on purpose. The
 * confirmation page holds the order the cart provider just returned and the
 * tracking page holds one fetched by number; neither has to hand over a shape
 * the other does not have, and neither can pass a field this block would
 * silently ignore.
 */
export function OrderSummary({
  subtotal,
  discountAmount,
  discountCode = null,
  deliveryFee,
  total,
  className,
}: {
  subtotal: number;
  discountAmount: number;
  discountCode?: string | null;
  deliveryFee: number;
  total: number;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <dl className={cn("mt-4 space-y-1.5 border-t border-[var(--store-border)] pt-3 text-sm", className)}>
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--store-muted)]">{t("store.cart.subtotal")}</dt>
        <dd className="font-bold"><Money value={subtotal} /></dd>
      </div>
      {discountAmount > 0 ? (
        <div className="flex justify-between gap-2 text-emerald-700">
          <dt>{t("store.cart.discount")}{discountCode ? ` · ${discountCode}` : ""}</dt>
          <dd className="font-bold">−<Money value={discountAmount} /></dd>
        </div>
      ) : null}
      {deliveryFee > 0 ? (
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--store-muted)]">{t("store.cart.deliveryFee")}</dt>
          <dd className="font-bold"><Money value={deliveryFee} /></dd>
        </div>
      ) : null}
      <div className="flex justify-between gap-2 border-t border-[var(--store-border)] pt-2 text-base">
        <dt className="font-black text-[var(--store-text)]">{t("store.cart.total")}</dt>
        <dd className="font-black text-[var(--store-text)]"><Money value={total} /></dd>
      </div>
    </dl>
  );
}
