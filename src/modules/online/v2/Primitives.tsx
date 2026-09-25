import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { adaptV2Appearance, v2Href } from "./appearance";
import { useStorefront } from "../hooks/StorefrontProvider";

/** The same lightweight, local icon set serves the real V2 shell and the
 * Admin's inert appearance sample. No uploaded SVG or icon-font requests. */
export type V2IconName = "menu" | "search" | "user" | "bag" | "close" | "arrow";
export function V2Icon({ name }: { name: V2IconName }) {
  const paths: Record<V2IconName, ReactNode> = {
    menu: <><path d="M3 7h18M3 12h18M3 17h18" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.5" /><path d="m16 16 5 5" /></>,
    user: <><circle cx="12" cy="8" r="3.4" /><path d="M5 21c.1-4 2.5-6 7-6s6.9 2 7 6" /></>,
    bag: <><path d="M4.5 8h15l1 13h-17l1-13ZM9 9V6a3 3 0 0 1 6 0v3" /></>,
    close: <><path d="M5 5l14 14M19 5 5 19" /></>,
    arrow: <><path d="M4 12h16m-7-7 7 7-7 7" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/** Safe configured CTA: canonical shop URLs render directly; old saved preview
 * URLs are normalised, and other validated destinations retain their policy. */
export function V2ActionLink({ href, children, className = "" }: {
  href: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const to = v2Href(href);
  if (!to) return null;
  if (to.startsWith("/")) return <Link to={to} className={className}>{children}</Link>;
  return <a href={to} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;
}

/** No bundled V2 photography: every URL is from ALYQ product/content/settings. */
export function V2Image({ src, mobileSrc, alt, priority = false, className = "", fit = "cover" }: {
  src?: string | null;
  mobileSrc?: string | null;
  alt: string;
  priority?: boolean;
  className?: string;
  fit?: "cover" | "contain";
}) {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const selected = src || mobileSrc || null;
  const failed = brokenSrc === selected;
  const { t } = useI18n();
  return (
    <span className={`v2-image ${className}`} data-testid="v2-image">
      {selected && !failed ? (
        <picture>
          {mobileSrc && src ? <source media="(max-width: 640px)" srcSet={mobileSrc} /> : null}
          <img
            src={selected}
            alt={alt}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            style={{ objectFit: fit }}
            onError={() => setBrokenSrc(selected)}
          />
        </picture>
      ) : (
        <span className="v2-image-fallback" role="img" aria-label={alt || t("store.v2.imageMissing")}>
          <span aria-hidden>◇</span>
          <small>{t("store.v2.imageMissing")}</small>
        </span>
      )}
    </span>
  );
}

export function V2Section({ id, title, eyebrow, action, children, className = "" }: {
  id?: string;
  title: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`v2-section ${className}`}>
      <div className="v2-section-head">
        <div>{eyebrow ? <p className="v2-eyebrow">{eyebrow}</p> : null}<h2 className="v2-section-title">{title}</h2></div>
        {action ? <div className="v2-section-action">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function V2ProductGrid({ children }: { children: ReactNode }) {
  const { settings } = useStorefront();
  return <div className="v2-product-grid" data-testid="v2-product-grid"
    data-gap={settings.product_card.gap}
    style={{
      "--v2-mobile-columns": adaptV2Appearance(settings).mobileColumns,
      "--v2-desktop-columns": Math.max(2, Math.min(6, Number(settings.product_card.desktop_columns) || 4)),
    } as CSSProperties}>
    {children}
  </div>;
}

export function V2Price({ price, className = "" }: {
  price: { price: number; list: number; from: boolean };
  className?: string;
}) {
  const { t, money } = useI18n();
  return <p className={`v2-price ${className}`}>
    {price.from ? <span className="v2-price-from">{t("store.variants.from")}</span> : null}
    <span>{money(price.price)}</span>
    {price.price < price.list ? <del>{money(price.list)}</del> : null}
  </p>;
}

export function V2Status({ available, mode, tracked = true, chosen = true }: {
  available: number | null;
  mode: "demo" | "supabase";
  tracked?: boolean;
  chosen?: boolean;
}) {
  const { t } = useI18n();
  if (!tracked) return <span className="v2-stock v2-stock-out">{t("store.v2.notOrderable")}</span>;
  if (!chosen) return <span className="v2-stock">{t("store.v2.pleaseChoose")}</span>;
  if (available === null) return null;
  if (available <= 0) return <span className="v2-stock v2-stock-out">{t("store.product.outOfStock")}</span>;
  if (available <= 5) return <span className="v2-stock v2-stock-limited">{mode === "demo"
    ? t("store.product.onlyLeft", { count: available })
    : t("store.v2.limited")}</span>;
  return <span className="v2-stock">{t("store.product.inStock")}</span>;
}

export function V2State({ kind, onRetry }: { kind: "loading" | "error" | "empty"; onRetry?: () => void }) {
  const { t } = useI18n();
  if (kind === "loading") return (
    <div className="v2-state v2-skeleton-row" role="status" aria-label={t("common.loading")} data-testid="v2-loading">
      <div /><div /><div /><div />
    </div>
  );
  return (
    <div className="v2-state" role={kind === "error" ? "alert" : "status"} data-testid={`v2-${kind}`}>
      <p>{t(kind === "error" ? "store.v2.error" : "store.v2.empty")}</p>
      {kind === "error" && onRetry ? (
        <button type="button" className="v2-outline-button" onClick={onRetry}>{t("store.v2.retry")}</button>
      ) : null}
    </div>
  );
}
