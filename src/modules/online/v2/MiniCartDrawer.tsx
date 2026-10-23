import { useEffect, useRef, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStoreCart } from "../hooks/StoreCartProvider";
import { V2Image } from "./Primitives";

/** A presentation of StoreCartProvider's existing cart; it owns no cart state. */
export function MiniCartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, pick, money } = useI18n();
  const { entries, totals, increase, decrease, remove, unitCount } = useStoreCart();
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const active = document.activeElement;
    restoreFocus.current = active instanceof HTMLElement ? active : null;
    const layer = dialog.current?.parentElement ?? null;
    const pageSiblings = [...(layer?.parentElement?.children ?? [])]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== layer)
      .map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }));
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    pageSiblings.forEach(({ element }) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      pageSiblings.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
      if (restoreFocus.current?.isConnected) restoreFocus.current.focus();
    };
  }, [onClose, open]);

  function trapTab(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),[tabindex="0"]',
    ) ?? [])].filter((node) => node.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="v2-cart-drawer-layer" data-open={open || undefined} hidden={!open}
      aria-hidden={!open} data-testid="v2-mini-cart-layer">
      <button type="button" className="v2-cart-drawer-backdrop" tabIndex={-1}
        aria-label={t("common.close")} onClick={onClose} />
      <aside ref={dialog} id="v2-cart-drawer" className="v2-cart-drawer" role="dialog" aria-modal="true"
        aria-labelledby="v2-cart-drawer-title" onKeyDown={trapTab} data-testid="v2-mini-cart">
        <div className="v2-cart-drawer-head">
          <div>
            <p className="v2-eyebrow">{t("store.v2.bag")}</p>
            <h2 id="v2-cart-drawer-title">{t("store.cart.title")}
              <span className="v2-cart-drawer-count">{unitCount}</span>
            </h2>
          </div>
          <button ref={closeButton} type="button" className="v2-cart-drawer-close"
            aria-label={t("common.close")} onClick={onClose}>×</button>
        </div>

        {entries.length ? <>
          <div className="v2-cart-drawer-lines" aria-label={t("store.cart.title")}>
            {entries.map((entry) => {
              const variantId = entry.variant?.id ?? null;
              const name = pick(entry.product.name_ar, entry.product.name_en);
              const image = entry.variant?.images?.[0] || entry.variant?.image_url ||
                entry.product.image_url || entry.product.images[0];
              return <article className="v2-cart-drawer-line" key={`${entry.product.id}:${variantId ?? ""}`}
                data-testid="v2-mini-cart-line" data-variant-id={variantId ?? ""}>
                <Link to={`/store/products/${encodeURIComponent(entry.content?.slug?.trim() || entry.product.id)}`}
                  className="v2-cart-drawer-photo" aria-label={name} onClick={onClose}>
                  <V2Image src={image} alt={name} fit="contain" />
                </Link>
                <div className="v2-cart-drawer-line-body">
                  <div className="v2-cart-drawer-line-heading">
                    <div><Link className="v2-cart-drawer-name"
                      to={`/store/products/${encodeURIComponent(entry.content?.slug?.trim() || entry.product.id)}`}
                      onClick={onClose}>{name}</Link>
                      {entry.variantLabel ? <p className="v2-cart-drawer-variant">{entry.variantLabel} · {entry.variant?.sku}</p>
                        : <p className="v2-cart-drawer-variant">{entry.product.sku}</p>}
                    </div>
                    <button type="button" className="v2-cart-drawer-remove"
                      aria-label={`${t("store.cart.remove")}: ${name}${entry.variantLabel ? `, ${entry.variantLabel}` : ""}`}
                      onClick={() => remove(entry.product.id, variantId)}>{t("store.cart.remove")}</button>
                  </div>
                  <div className="v2-cart-drawer-line-bottom">
                    <div className="v2-cart-drawer-stepper" role="group"
                      aria-label={`${t("store.v2.quantity")}: ${name}${entry.variantLabel ? `, ${entry.variantLabel}` : ""}`}>
                      <button type="button" aria-label={t("store.cart.decrease")}
                        onClick={() => decrease(entry.product.id, variantId)}>−</button>
                      <output aria-label={t("store.v2.quantity")}>{entry.quantity}</output>
                      <button type="button" aria-label={t("store.cart.increase")}
                        disabled={entry.available !== null && entry.quantity >= entry.available}
                        onClick={() => increase(entry.product.id, variantId)}>+</button>
                    </div>
                    <strong className="v2-cart-drawer-price">{money(entry.lineTotal)}</strong>
                  </div>
                </div>
              </article>;
            })}
          </div>
          <div className="v2-cart-drawer-summary">
            <div><span>{t("store.cart.subtotal")}</span><strong>{money(totals.subtotal)}</strong></div>
            {totals.auto_discount + totals.discount_amount > 0 ? <div>
              <span>{t("store.cart.discount")}</span>
              <strong>−{money(totals.auto_discount + totals.discount_amount)}</strong>
            </div> : null}
            <div className="v2-cart-drawer-total"><span>{t("store.cart.total")}</span><strong>{money(totals.total)}</strong></div>
            <p>{t("store.v2.stockAtCheckout")}</p>
          </div>
          <div className="v2-cart-drawer-actions">
            <Link to="/store/checkout" className="v2-primary-button" onClick={onClose}
              data-testid="v2-mini-cart-checkout">{t("store.cart.checkout")}</Link>
            <Link to="/store/cart" className="v2-cart-drawer-full" onClick={onClose}>{t("store.cart.summary")}</Link>
            <button type="button" className="v2-cart-drawer-continue" onClick={onClose}>
              {t("store.cart.continueShopping")}
            </button>
          </div>
        </> : <div className="v2-cart-drawer-empty">
          <p>{t("store.cart.emptyHint")}</p>
          <Link to="/store/products" className="v2-primary-button" onClick={onClose}>
            {t("store.cart.startShopping")}</Link>
        </div>}
      </aside>
    </div>
  );
}
