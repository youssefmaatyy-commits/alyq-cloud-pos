import { useI18n } from "@/lib/i18n/I18nProvider";

/**
 * Neutral Bootstrap Shield.
 *
 * Rendered during storefront cold boot / hard refresh while the authoritative
 * website settings and theme configuration are unresolved.
 *
 * Visual Invariants:
 * 1. Must NOT render any default/fake dark header or fake navigation.
 * 2. Must NOT render default ALYQ wordmark or default palette.
 * 3. Uses neutral, stable skeleton placeholders that avoid layout shift.
 * 4. Fully accessible with role="status" and aria-busy="true".
 */
export function StorefrontV2BootstrapShield() {
  const { t } = useI18n();

  return (
    <div
      className="v2-bootstrap-shield"
      role="status"
      aria-label={t("common.loading")}
      aria-busy="true"
      data-testid="v2-bootstrap-shield"
    >
      {/* Neutral skeleton header */}
      <header className="v2-bootstrap-header" aria-hidden="true">
        <div className="v2-bootstrap-header-inner">
          <div className="v2-bootstrap-nav-placeholder">
            <span className="v2-skeleton-pulse v2-skeleton-icon" />
          </div>
          <div className="v2-bootstrap-brand-placeholder">
            <span className="v2-skeleton-pulse v2-skeleton-brand" />
          </div>
          <div className="v2-bootstrap-actions-placeholder">
            <span className="v2-skeleton-pulse v2-skeleton-icon" />
            <span className="v2-skeleton-pulse v2-skeleton-icon" />
          </div>
        </div>
      </header>

      {/* Neutral skeleton body */}
      <main className="v2-bootstrap-main" aria-hidden="true">
        {/* Hero banner skeleton */}
        <div className="v2-bootstrap-hero">
          <div className="v2-skeleton-pulse v2-skeleton-hero-box" />
        </div>

        {/* Categories / chips skeleton */}
        <div className="v2-bootstrap-chips">
          <div className="v2-skeleton-pulse v2-skeleton-chip" />
          <div className="v2-skeleton-pulse v2-skeleton-chip" />
          <div className="v2-skeleton-pulse v2-skeleton-chip" />
          <div className="v2-skeleton-pulse v2-skeleton-chip" />
        </div>

        {/* Product grid skeleton */}
        <div className="v2-bootstrap-grid">
          <div className="v2-skeleton-pulse v2-skeleton-card" />
          <div className="v2-skeleton-pulse v2-skeleton-card" />
          <div className="v2-skeleton-pulse v2-skeleton-card" />
          <div className="v2-skeleton-pulse v2-skeleton-card" />
        </div>
      </main>

      {/* Neutral skeleton footer */}
      <footer className="v2-bootstrap-footer" aria-hidden="true">
        <div className="v2-skeleton-pulse v2-skeleton-footer-bar" />
      </footer>
    </div>
  );
}

/**
 * Controlled Error Shield for unresolved storefront settings failure.
 */
export function StorefrontV2ErrorShield({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry?: () => void;
}) {
  const { t } = useI18n();

  return (
    <div
      className="v2-bootstrap-shield v2-error-shield"
      role="alert"
      aria-live="assertive"
      data-testid="v2-error-shield"
    >
      <header className="v2-bootstrap-header">
        <div className="v2-bootstrap-header-inner">
          <div className="v2-bootstrap-brand-placeholder">
            <span className="v2-skeleton-brand" style={{ background: "#d1d5db" }} />
          </div>
        </div>
      </header>

      <main className="v2-bootstrap-main v2-error-main">
        <div className="v2-state" data-testid="v2-error">
          <p className="v2-error-message">{error || t("store.v2.error")}</p>
          {onRetry ? (
            <button
              type="button"
              className="v2-outline-button"
              onClick={onRetry}
              data-testid="v2-retry-button"
            >
              {t("store.v2.retry")}
            </button>
          ) : null}
        </div>
      </main>
    </div>
  );
}
