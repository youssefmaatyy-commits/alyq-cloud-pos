import { useEffect, useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import { LoadingBlock, ErrorState } from "@/components/ui";
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

  const headerActions = useMemo(
    () => (
      <span className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-600">
        <span aria-hidden>📷</span>
        {t("pos.scanHint")}
      </span>
    ),
    [t],
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
