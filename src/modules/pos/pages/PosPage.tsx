import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { LoadingBlock, ErrorState, useToast } from "@/components/ui";
import {
  openExternalStorefront,
  resolveStorefrontTarget,
} from "@/lib/storefront/storefrontLink";
import { usePos } from "../hooks/PosProvider";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { PosSearchPanel } from "../components/PosSearchPanel";
import { CartPanel } from "../components/CartPanel";
import { SaleCompletedModal } from "../components/SaleCompletedModal";
import { TransactionLookupModal } from "../components/TransactionLookupModal";
import { CustomerSearchSelect } from "@/modules/customers/components/CustomerSearchSelect";

/**
 * POS register screen.
 *
 * Layout: a broad catalog/scan workspace (~56%) beside ONE dense Current Sale
 * card (~44%) on desktop. The product surface is card-oriented for touch and
 * laptop browsing; the sale card keeps the fixed header, scrolling lines and
 * payment footer. Below lg checkout moves into the existing mobile cart sheet.
 *
 * Barcode scanners work anywhere on this page (see `useBarcodeScanner`):
 * their rapid keystrokes are detected and added to the cart directly. A scan
 * typed into the focused search box is added by the box itself, exactly once.
 */
export function PosPage() {
  const { t } = useI18n();
  const { addBySku, loading, error, reloadCatalog } = usePos();
  const toast = useToast();

  // Where "Open website" goes: the shop built into this bundle by default, or
  // the origin named by VITE_STOREFRONT_URL when the shop is hosted separately.
  const storefront = useMemo(() => resolveStorefrontTarget(), []);
  const configWarningShown = useRef(false);
  const [lookupOpen, setLookupOpen] = useState(false);

  // Re-read the catalog every time the till is opened so stock numbers are
  // fresh (a reset, inventory adjustment or new product is reflected).
  useEffect(() => {
    void reloadCatalog();
  }, [reloadCatalog]);

  // Scan → add to cart. No-op UI is needed on success (the cart updates);
  // a miss shows a transient toast plus a pulse on the scan/search box.
  const onScan = (code: string) => {
    const added = addBySku(code);
    if (!added) {
      toast.error(t("pos.codeUnavailable"));
      // small non-blocking visual cue: pulse the scan/search box via a class
      const input = document.querySelector<HTMLInputElement>(
        'input[data-testid="pos-scan-search"]',
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
        <button type="button" onClick={() => setLookupOpen(true)} data-testid="pos-transaction-lookup"
          className="inline-flex h-8 items-center rounded-xl bg-stone-900 px-3 text-xs font-bold text-white hover:bg-stone-700">
          <span aria-hidden className="me-1.5">⌕</span>{t("pos.lookup")}
        </button>
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
            className="inline-flex h-8 items-center rounded-xl bg-white px-3 text-xs font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            {t("nav.viewStore")}
            <span aria-hidden className="ms-1.5">↗</span>
          </a>
        ) : (
          <Link
            to={storefront.to}
            data-testid="pos-open-website"
            className="inline-flex h-8 items-center rounded-xl bg-white px-3 text-xs font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
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
    // Desktop: subtract the shell's 3.5rem top bar and 3rem main padding. The
    // min-height floor keeps the Current Sale card's fixed sections (header +
    // totals + payment) usable on short screens — below it the page itself
    // scrolls instead of crushing the cart list to zero. The floor equals the
    // 768px-viewport height exactly (41.5rem = 100dvh − 6.5rem), so it only
    // binds on SHORTER viewports and never adds page scroll at 768 or above.
    <div className="flex h-full flex-col lg:h-[calc(100dvh-6.5rem)] lg:min-h-[41.5rem]">
      {/* Compact register header: the register is viewport-bounded, so a tall
          page header would eat the cart list's scroll budget. One row — title
          and the storefront link — keeps ~35px for the cart viewport. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-2 lg:pb-3">
        <h1 className="text-base font-black tracking-tight text-stone-900">{t("nav.register")}</h1>
        {headerActions}
      </div>

      {/* The single desktop row must be a definite track, not auto-sized:
          a content-sized row makes the checkout aside's percentage height
          cyclic (it falls back to content height), so the card's flex-1 cart
          list never receives a bounded height and cannot scroll.
          minmax(0,1fr) sizes the row from the shell-derived grid height —
          floored at 0 so a long cart can never inflate it — giving both
          columns a definite height to resolve against. */}
      <div className="grid min-w-0 flex-1 gap-4 lg:min-h-0 lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,56fr)_minmax(22rem,44fr)] lg:rtl:grid-cols-[minmax(22rem,44fr)_minmax(0,56fr)] lg:items-start">
        {/* A zero-minimum track and item stop the search column's intrinsic
            width from pushing the fixed-width checkout off screen. The search
            column holds one input and a compact result dropdown — it never
            scrolls a catalogue; only the cart's own line list scrolls when
            the sale is long. Below lg the page scrolls normally. */}
        <div className="min-w-0 lg:order-1 lg:rtl:order-2 lg:h-full lg:min-h-0" data-testid="pos-search-column">
          <PosSearchPanel />
        </div>

        {/* Desktop checkout fills its whole 65% track with ONE Current Sale
            card (header → scrolling cart lines → totals + payment). The card
            owns the checkout's only scroll: its cart line list. The wrapper
            carries the flexible track sizing so the card can resolve h-full
            against a definite height; w-full/min-w-0 keep it as wide as the
            track. On RTL the 65fr track is mirrored to the right side. */}
        <aside
          className="hidden w-full min-w-0 flex-col lg:order-2 lg:rtl:order-1 lg:sticky lg:top-16 lg:flex lg:h-full lg:min-h-0 lg:self-start"
          data-testid="pos-checkout-panel"
        >
          <div className="w-full min-w-0 lg:min-h-0 lg:flex-1">
            <CartPanel />
          </div>
        </aside>
      </div>

      {/* Mobile: sticky cart summary → drawer with the same card. */}
      <MobileCartSheet />

      <SaleCompletedModal />
      {lookupOpen ? <TransactionLookupModal onClose={() => setLookupOpen(false)} /> : null}
    </div>
  );
}

/**
 * Phone layout for the register (Phase 46).
 *
 * The sale panel is hidden on small screens; a sticky bar carries the honest
 * running count and total and opens a drawer holding the very same Current
 * Sale card (cart, totals and payment together) — one checkout flow, not a
 * second mobile one.
 */
function MobileCartSheet() {
  const { t, num } = useI18n();
  const { lines, totals, isEmpty, selectedCustomer, setSelectedCustomer } = usePos();
  const [open, setOpen] = useState(false);
  const count = lines.reduce((sum, line) => sum + line.qty, 0);

  // Closing the drawer on an emptied cart keeps the flow honest: after "New
  // sale" the cashier is back on the search box, not staring at an empty drawer.
  useEffect(() => {
    if (isEmpty) setOpen(false);
  }, [isEmpty]);

  if (isEmpty) {
    return (
      <div className="sticky bottom-0 z-30 -mx-3 mt-3 border-t border-stone-200 bg-white/95 px-3 py-2.5 backdrop-blur lg:hidden">
        <CustomerSearchSelect
          selectedCustomerId={selectedCustomer?.id ?? null}
          onSelect={(customer) => setSelectedCustomer(customer)}
        />
      </div>
    );
  }

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
            className="pos-grip-scrollbar absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col gap-3 overflow-y-auto rounded-t-3xl bg-[#f7f5f2] p-3 pb-6 shadow-2xl"
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
            {/* The whole sale — cart lines, totals and payment — is one card.
                At natural height the drawer scrolls it as a whole, so the
                cashier reaches the payment button by scrolling the sheet. */}
            <div className="min-h-[22rem] shrink-0">
              <CartPanel />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
