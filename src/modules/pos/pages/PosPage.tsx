import { useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import { LoadingBlock, ErrorState, useToast } from "@/components/ui";
import { resolveStorefrontTarget } from "@/lib/storefront/storefrontLink";
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

        <aside className="flex flex-col gap-4 lg:sticky lg:top-16 lg:max-h-[calc(100vh-9rem)]">
          <div className={isEmpty ? "" : "min-h-[260px] lg:min-h-0 lg:flex-1"}>
            <CartPanel />
          </div>
          <PaymentPanel />
        </aside>
      </div>

      <SaleCompletedModal />
    </div>
  );
}
