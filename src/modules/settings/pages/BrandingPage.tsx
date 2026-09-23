/**
 * Settings → Branding (Phase 46).
 *
 * ONE shared brand source: this screen edits the `brand` group of the same
 * `website_settings` document the storefront reads, plus the storefront's
 * primary logo (`images.logo_url`) — not a second copy of it. What is set here
 * is what the admin sidebar, the login page, the dashboard header and the
 * printed receipts (unless the receipt toggle is off) all show.
 *
 * Save pipeline = the Website centre's own: `sanitizeSettings` before the
 * write, the `website_settings_guard` (0045 + 0046) re-checking server-side.
 * URLs are media URLs through the catalogue's image validation — never raw
 * SVG/HTML injection. Removing the logo degrades every surface to the shipped
 * ALYQ wordmark, which is the fallback the whole app is built on.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { canActAs } from "@/lib/permissions/enforce";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useAuth } from "@/lib/auth";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  TextInput,
  ToggleSwitch,
  useToast,
} from "@/components/ui";
import { SettingsImageField } from "@/modules/online/components/admin/SettingsImageField";
import { getWebsiteRepository } from "@/modules/online/data";
import { toOnlineError, type OnlineErrorCode } from "@/modules/online/data/repository";
import { resolveSettings, sanitizeSettings } from "@/modules/online/services/settingsDefaults";
import type { WebsiteSettings } from "@/modules/online/types";
import {
  brandDisplayName,
  invalidateBrandCache,
  resolveBrand,
} from "@/lib/branding/brand";

export function BrandingPage() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const repository = useMemo(() => getWebsiteRepository(), []);
  const canManage = canActAs(user, "manage_website");

  const [saved, setSaved] = useState<WebsiteSettings | null>(null);
  const [draft, setDraft] = useState<WebsiteSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<OnlineErrorCode | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const snapshot = await repository.getSnapshot();
        if (cancelled) return;
        const resolved = resolveSettings(snapshot.settings);
        setSaved(resolved);
        setDraft(resolved);
        setLoadError(null);
      } catch (caught) {
        if (!cancelled) setLoadError(toOnlineError(caught).code);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const dirty = useMemo(
    () => Boolean(saved && draft && JSON.stringify(saved) !== JSON.stringify(draft)),
    [draft, saved],
  );

  const patch = useCallback((change: (current: WebsiteSettings) => WebsiteSettings) => {
    setDraft((current) => (current ? change(current) : current));
  }, []);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const actor = getCurrentUser();
      await repository.saveSettings({
        settings: sanitizeSettings(draft),
        user_id: actor.id,
        user_name: actor.name,
      });
      setSaved(draft);
      // The shell, login and receipts resolve through the cached loader.
      invalidateBrandCache();
      toast.success(t("admin.branding.saved"));
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setSaving(false);
    }
  };

  if (!canManage) {
    return (
      <div>
        <PageHeader title={t("admin.branding.title")} subtitle={t("admin.branding.subtitle")} />
        <Card>
          <EmptyState
            icon="🔒"
            title={t("admin.branding.noAccess")}
            description={t("admin.branding.noAccessHint")}
          />
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <PageHeader title={t("admin.branding.title")} subtitle={t("admin.branding.subtitle")} />
        <LoadingBlock label={t("common.loading")} />
      </div>
    );
  }

  if (loadError || !draft) {
    return (
      <div>
        <PageHeader title={t("admin.branding.title")} subtitle={t("admin.branding.subtitle")} />
        <Card>
          <ErrorState
            title={t("common.error")}
            message={t(`online.error.${loadError ?? "network"}`)}
            retryLabel={t("common.retry")}
            onRetry={() => window.location.reload()}
          />
        </Card>
      </div>
    );
  }

  const brand = resolveBrand(draft);
  const sidebarName = brandDisplayName(brand, lang);
  const otherLang: "ar" | "en" = lang === "ar" ? "en" : "ar";

  return (
    <div>
      <PageHeader
        title={t("admin.branding.title")}
        subtitle={t("admin.branding.subtitle")}
        crumbs={[{ label: t("home.breadcrumb.settings"), to: "/settings" }, { label: t("admin.branding.title") }]}
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving} data-testid="branding-save">
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card>
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-black text-stone-900">{t("admin.branding.logosTitle")}</h2>
                <p className="mt-0.5 text-xs font-medium text-stone-500">{t("admin.branding.logosHint")}</p>
              </div>
              <SettingsImageField
                label={t("admin.branding.primaryLogo")}
                hint={t("admin.branding.primaryLogoHint")}
                value={draft.images.logo_url}
                previewClass="h-28 w-full"
                disabled={saving}
                onChange={(url) => patch((c) => ({ ...c, images: { ...c.images, logo_url: url } }))}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <SettingsImageField
                  label={t("admin.branding.compactMark")}
                  hint={t("admin.branding.compactMarkHint")}
                  value={draft.brand.mark_url}
                  previewClass="h-24 w-full"
                  disabled={saving}
                  onChange={(url) => patch((c) => ({ ...c, brand: { ...c.brand, mark_url: url } }))}
                />
                <SettingsImageField
                  label={t("admin.branding.darkLogo")}
                  hint={t("admin.branding.darkLogoHint")}
                  value={draft.brand.logo_dark_url}
                  previewClass="h-24 w-full bg-stone-900"
                  disabled={saving}
                  onChange={(url) => patch((c) => ({ ...c, brand: { ...c.brand, logo_dark_url: url } }))}
                />
              </div>
              <Field label={t("admin.branding.nameAr")}>
                <TextInput
                  value={draft.brand.display_name_ar}
                  disabled={saving}
                  data-testid="branding-name-ar"
                  onChange={(e) =>
                    patch((c) => ({ ...c, brand: { ...c.brand, display_name_ar: e.target.value } }))
                  }
                />
              </Field>
              <Field label={t("admin.branding.nameEn")}>
                <TextInput
                  value={draft.brand.display_name_en}
                  disabled={saving}
                  data-testid="branding-name-en"
                  onChange={(e) =>
                    patch((c) => ({ ...c, brand: { ...c.brand, display_name_en: e.target.value } }))
                  }
                />
              </Field>
              <ToggleSwitch
                checked={draft.brand.receipt_logo_enabled}
                disabled={saving}
                label={t("admin.branding.receiptToggle")}
                hint={t("admin.branding.receiptToggleHint")}
                id="branding-receipt-toggle"
                onChange={(checked) => patch((c) => ({ ...c, brand: { ...c.brand, receipt_logo_enabled: checked } }))}
              />
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
              {t("admin.branding.previewTitle")}
            </p>
            {/* Dark sidebar preview */}
            <div
              className="mt-3 flex items-center gap-2.5 rounded-xl bg-stone-900 px-3 py-3"
              data-testid="branding-preview-sidebar"
            >
              {brand.markUrl ? (
                <img src={brand.markUrl} alt="" className="h-8 w-8 shrink-0 rounded-lg object-contain" />
              ) : (
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 text-[11px] font-black text-white">
                  AL
                </span>
              )}
              <span className="truncate text-sm font-black text-white">{sidebarName}</span>
            </div>
            {/* Light surface preview */}
            <div className="mt-2 flex items-center gap-2.5 rounded-xl border border-stone-200 bg-white px-3 py-3">
              {brand.logoUrl ? (
                <img src={brand.logoUrl} alt="" className="h-8 w-8 shrink-0 rounded-lg object-contain" />
              ) : (
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-stone-100 text-[11px] font-black text-stone-700">
                  AL
                </span>
              )}
              <span className="truncate text-sm font-black text-stone-900">
                {brandDisplayName(brand, otherLang)}
              </span>
            </div>
            <p className="mt-3 text-[11px] font-medium text-stone-500">{t("admin.branding.previewNote")}</p>
          </Card>
          <Card>
            <p className="text-xs font-semibold leading-relaxed text-stone-600">
              {t("admin.branding.placementNote")}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
