import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import { LoadingBlock, ErrorState, useToast } from "@/components/ui";
import {
  openExternalStorefront,
  resolveStorefrontTarget,
} from "@/lib/storefront/storefrontLink";
import { usePos } from "../hooks/PosProvider";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { ProductGrid } from "../components/ProductGrid";
import { CartPanel } from "../components/CartPanel";
import { PaymentPanel } from "../components/PaymentPanel";
import { SaleCompletedModal } from "../components/SaleCompletedModal";

/**
 * POS register screen.
 *
 * Layout: sticky product grid on the left, cart + payment on the right.
 * On mobile the grid is full-width and the cart panel collapses into a
 * compact horizontal sheet with the payment section below.
 *
 * Barcode scanners work anywhere on this page (see `useBarcodeScanner`):
 * their rapid keystrokes are detected and added to the cart directly.
 */
export function PosPage() {
  const { t } = useI18n();
  const { addBySku, loading, error, isEmpty, reloadCatalog } = usePos();
  const toast = useToast();

  // Where "Open website" goes: the shop built into this bundle by default, or
  // the origin named by VITE_STOREFRONT_URL when the shop is hosted separately.
  const storefront = useMemo(() => resolveStorefrontTarget(), []);
  const configWarningShown = useRef(false);

  // Re-read the catalog every time the till is opened so stock numbers are
  // fresh (a reset, inventory adjustment or new product is reflected).
  useEffect(() => {
    void reloadCatalog();
  }, [reloadCatalog]);

  // Scan → add to cart. No-op UI is needed on success (the badge on the
  // product card updates); a miss shows a transient warning via the title.
  const onScan = (code: string) => {
    const added = addBySku(code);
    if (!added) {
      // small non-blocking visual cue: shake the search box via a class
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="' + t("pos.search") + '"]',
      );
      if (input) {
        input.classList.add("animate-pulse");
        window.setTimeout(() => input.classList.remove("animate-pulse"), 600);
      }
    }
  };
  useBarcodeScanner(onScan);

  // A storefront URL that was configured but cannot be used is reported once,
  // not swallowed: the control still opens the built-in shop, and the operator
  // learns the deployment setting is wrong instead of wondering why a link they
  // pointed at their own domain keeps landing on the bundled one.
  useEffect(() => {
    if (storefront.warning === "invalid_url" && !configWarningShown.current) {
      configWarningShown.current = true;
      toast.error(t("pos.openWebsiteConfigInvalid"));
    }
  }, [storefront.warning, toast, t]);

  const headerActions = useMemo(
    () => (
      <span className="inline-flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-600">
          <span aria-hidden>📷</span>
          {t("pos.scanHint")}
        </span>
        {/* The shop, from the till. Internal navigation on purpose: same bundle,
            no popup for a blocker to swallow, and identical behaviour in demo
            and live mode. Same control style as the website settings screen. */}
        {storefront.href ? (
          <a
            href={storefront.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="pos-open-website-external"
            onClick={(event) => {
              // A deployment that hosts the shop elsewhere still has to open it
              // from a till browser that may refuse the new tab.
              event.preventDefault();
              openExternalStorefront(storefront.href as string);
            }}
            className="inline-flex h-10 items-center rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            {t("nav.viewStore")}
            <span aria-hidden className="ms-1.5">↗</span>
          </a>
        ) : (
          <Link
            to={storefront.to}
            data-testid="pos-open-website"
            className="inline-flex h-10 items-center rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            {t("nav.viewStore")}
          </Link>
        )}
      </span>
    ),
    [t, storefront],
  );

  if (loading) {
    return (
      <div className="alyq-card">
        <LoadingBlock label={t("common.loading")} />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        title={t("products.errorLoad")}
        message={error.message}
        retryLabel={t("common.retry")}
        onRetry={() => {
          // A reload re-runs the provider's catalog load.
          window.location.reload();
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("nav.register")} subtitle={t("app.tagline")} actions={headerActions} />

      <div className="grid flex-1 gap-4 lg:grid-cols-[1fr_380px]">
        <div className="min-h-[420px]">
          <ProductGrid />
        </div>

        {/* Desktop/tablet: the sale panel lives beside the grid. On phones the
            same panels move into a drawer (below) behind a sticky summary bar —
            identical behaviour, a thumb-reachable way in. */}
        <aside className="hidden flex-col gap-4 lg:flex lg:sticky lg:top-16 lg:max-h-[calc(100vh-9rem)]">
          <div className={isEmpty ? "" : "min-h-[260px] lg:min-h-0 lg:flex-1"}>
            <CartPanel />
          </div>
          <PaymentPanel />
        </aside>
      </div>

      {/* Discoverability row (Phase 46). The register had no keyboard bindings,
          so nothing is claimed or rebound — these are the real controls,
          reachable in one look: customer, discount, new sale. */}
      <div className="mt-3 hidden flex-wrap items-center gap-2 border-t border-stone-200 pt-3 text-xs font-semibold text-stone-500 lg:flex" data-testid="pos-footer">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 ring-1 ring-stone-200">
          🧑‍🤝‍🧑 {t("pos.footer.customer")}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 ring-1 ring-stone-200">
          % {t("pos.footer.discount")}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 ring-1 ring-stone-200">
          📷 {t("pos.scanHint")}
        </span>
        <span className="ms-auto inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-3 py-1.5 text-[#f3ede1]">
          {t("pos.footer.completeInPanel")}
        </span>
      </div>

      {/* Mobile: sticky cart summary → drawer with the same panels. */}
      <MobileCartSheet />

      <SaleCompletedModal />
    </div>
  );
}

/**
 * Phone layout for the register (Phase 46).
 *
 * The sale panel is hidden on small screens; a sticky bar carries the honest
 * running count and total and opens a drawer holding the very same
 * CartPanel + PaymentPanel — one checkout flow, not a second mobile one.
 */
function MobileCartSheet() {
  const { t, num } = useI18n();
  const { lines, totals, isEmpty } = usePos();
  const [open, setOpen] = useState(false);
  const count = lines.reduce((sum, line) => sum + line.qty, 0);

  // Closing the drawer on an emptied cart keeps the flow honest: after "New
  // sale" the cashier is back on the grid, not staring at an empty drawer.
  useEffect(() => {
    if (isEmpty) setOpen(false);
  }, [isEmpty]);

  if (isEmpty) return null;

  return (
    <>
      <div className="sticky bottom-0 z-30 -mx-3 mt-3 border-t border-stone-200 bg-white/95 px-3 py-2.5 backdrop-blur sm:-mx-4 sm:px-4 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="pos-mobile-cart-open"
          className="flex w-full items-center justify-between gap-3 rounded-xl bg-stone-900 px-4 py-3 text-sm font-bold text-[#f3ede1]"
        >
          <span className="flex items-center gap-2">
            🧾 {t("pos.cart")}
            <span className="grid h-6 min-w-6 place-items-center rounded-full bg-white/15 px-1.5 text-xs tabular-nums">
              {count}
            </span>
          </span>
          <span className="tabular-nums">{num(totals.total, 2)}</span>
        </button>
      </div>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-stone-950/60" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-label={t("pos.cart")}
            data-testid="pos-mobile-cart-drawer"
            className="absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col gap-3 overflow-y-auto rounded-t-3xl bg-[#f7f5f2] p-3 pb-6 shadow-2xl"
          >
            <div className="mx-auto h-1.5 w-12 rounded-full bg-stone-300" aria-hidden />
            <div className="flex items-center justify-between px-1">
              <p className="text-sm font-black text-stone-900">{t("pos.cart")}</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("common.close")}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100"
              >
                ✕
              </button>
            </div>
            <CartPanel />
            <PaymentPanel />
          </div>
        </div>
      ) : null}
    </>
  );
}
