/**
 * Settings → Website Customization.
 *
 * Everything about the shop's appearance that used to need a developer: the
 * logo, the favicon, the hero pictures, the colours, the fonts, the button
 * shape, the homepage's sections and their order, the social links, the delivery
 * rules, the InstaPay details and the SEO text. It is one document
 * (`WebsiteSettings`) saved as one row, so the storefront cannot be half-configured
 * — either the save happened or it did not.
 *
 * The builder edits a *draft*. Nothing reaches the website until Save, and the
 * preview on the right renders that draft through the same theme helpers the
 * storefront uses, so what you see there is what a customer gets.
 *
 * Guarded by `manage_website`: a cashier can work online orders without being
 * able to repaint the shop.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { canActAs } from "@/lib/permissions/enforce";
import { openStorefrontRoute } from "@/lib/storefront/storefrontLink";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useAuth } from "@/lib/auth";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { useCatalog } from "@/modules/products";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  SelectInput,
  TextArea,
  TextInput,
  ToggleSwitch,
  useToast,
} from "@/components/ui";
import { getWebsiteRepository } from "../data";
import { toOnlineError, type OnlineErrorCode } from "../data/repository";
import { resolveSettings, sanitizeSettings } from "../services/settingsDefaults";
import {
  moveSection,
  orderedSections,
  resetSections,
  setSectionLimit,
  setSectionTitle,
  setSectionVisible,
  sectionTitleKey,
  PRODUCT_SECTIONS,
} from "../services/sections";
import {
  buildRobotsTxt,
  buildSitemapXml,
  downloadTextFile,
  storefrontSitemapPages,
} from "../services/seo";
import { BUTTON_STYLES, HEADER_STYLES, STORE_FONT_STACKS } from "../types";
import type {
  ProductContent,
  HeroSlide,
  HomepageSectionConfig,
  PromoBanner,
  WebsiteSettings,
  WebsiteSettingsMeta,
} from "../types";
import { SettingsImageField } from "../components/admin/SettingsImageField";
import { StorefrontPreview } from "../components/admin/StorefrontPreview";
import {
  CampaignsPanel,
  CategoriesContentPanel,
  CheckoutCopyPanel,
  ConfirmationPanel,
  FooterPanel,
  HeaderPanel,
  ProductDisplayPanel,
  SectionContentPanel,
  SocialPanel,
} from "../components/admin/website/WebsiteTabPanels";

type Tab =
  | "general"
  | "homepage"
  | "hero"
  | "sections"
  | "categories"
  | "campaigns"
  | "productDisplay"
  | "productContent"
  | "theme"
  | "header"
  | "footer"
  | "social"
  | "delivery"
  | "checkout"
  | "confirmation";

const TABS: { key: Tab; labelKey: string }[] = [
  { key: "general", labelKey: "online.ws.general" },
  { key: "homepage", labelKey: "online.ws.homepage" },
  { key: "hero", labelKey: "online.ws.hero" },
  { key: "sections", labelKey: "online.ws.sections" },
  { key: "categories", labelKey: "online.ws.categoriesTab" },
  { key: "campaigns", labelKey: "online.ws.campaigns" },
  { key: "productDisplay", labelKey: "online.ws.productDisplay" },
  { key: "productContent", labelKey: "online.ws.productContent" },
  { key: "theme", labelKey: "online.ws.theme" },
  { key: "header", labelKey: "online.ws.header" },
  { key: "footer", labelKey: "online.ws.footer" },
  { key: "social", labelKey: "online.ws.social" },
  { key: "delivery", labelKey: "online.ws.delivery" },
  { key: "checkout", labelKey: "online.ws.checkout" },
  { key: "confirmation", labelKey: "online.ws.confirmation" },
];

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const emptySlide = (): HeroSlide => ({
  id: newId(),
  image_url: null,
  title_ar: "",
  title_en: "",
  subtitle_ar: "",
  subtitle_en: "",
  cta_label_ar: "",
  cta_label_en: "",
  cta_href: "#/store/products",
  align: "center",
});

const emptyBanner = (): PromoBanner => ({
  id: newId(),
  image_url: null,
  title_ar: "",
  title_en: "",
  caption_ar: "",
  caption_en: "",
  href: "",
  badge_ar: "",
  badge_en: "",
});

export function WebsiteSettingsPage() {
  const { t, date } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const { products, categories } = useCatalog();
  const repository = useMemo(() => getWebsiteRepository(), []);
  const canManage = canActAs(user, "manage_website");

  const [saved, setSaved] = useState<WebsiteSettings | null>(null);
  const [draft, setDraft] = useState<WebsiteSettings | null>(null);
  const [meta, setMeta] = useState<WebsiteSettingsMeta | null>(null);
  /** Product slugs, so the sitemap can list real product URLs. */
  const [contents, setContents] = useState<ProductContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<OnlineErrorCode | null>(null);
  const [tab, setTab] = useState<Tab>("general");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const snapshot = await repository.getSnapshot();
        if (cancelled) return;
        // Best effort: a sitemap without product URLs is still a valid sitemap,
        // and failing the whole screen over it would be disproportionate.
        try {
          const list = await repository.listProductContents();
          if (!cancelled) setContents(list);
        } catch {
          if (!cancelled) setContents([]);
        }
        const resolved = resolveSettings(snapshot.settings);
        setSaved(resolved);
        setDraft(resolved);
        setMeta(snapshot.meta);
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

  /** One place to mutate the draft, so a field cannot forget to mark it dirty. */
  const patch = useCallback((change: (current: WebsiteSettings) => WebsiteSettings) => {
    setDraft((current) => (current ? change(current) : current));
  }, []);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const actor = getCurrentUser();
      // Phase 45: the document is sanitized before it leaves the page — the
      // same policy the database guard enforces (0045), applied client-side so
      // an unsafe URL or an oversized list is refused with the form still open
      // rather than by a SQL error after submit. Sanitizing is idempotent, so
      // a document that is already clean saves unchanged.
      const nextMeta = await repository.saveSettings({
        settings: sanitizeSettings(draft),
        user_id: actor.id,
        user_name: actor.name,
      });
      setSaved(draft);
      setMeta(nextMeta);
      toast.success(t("online.settings.saved"));
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setSaving(false);
    }
  };

  const baseUrl = typeof window === "undefined" ? "" : window.location.origin;

  if (!canManage) {
    return (
      <div>
        <PageHeader title={t("online.settings.title")} subtitle={t("online.settings.subtitle")} />
        <Card>
          <EmptyState icon="🔒" title={t("online.settings.noAccess")} description={t("online.settings.noAccessHint")} />
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <PageHeader title={t("online.settings.title")} subtitle={t("online.settings.subtitle")} />
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      </div>
    );
  }

  if (loadError || !draft || !saved) {
    return (
      <div>
        <PageHeader title={t("online.settings.title")} subtitle={t("online.settings.subtitle")} />
        <ErrorState
          title={t("common.error")}
          message={t(`online.error.${loadError ?? "network"}`)}
          retryLabel={t("common.retry")}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const sections = orderedSections(draft);

  const updateSection = (next: HomepageSectionConfig[]) =>
    patch((current) => ({ ...current, sections: next }));

  return (
    <div>
      <PageHeader
        title={t("online.settings.title")}
        subtitle={t("online.settings.subtitle")}
        actions={
          <>
            {/* Same dead-click class as the shell entry: a new tab is refused
                without feedback in an embedded host, so fall back to this one. */}
            <a
              href="#/store"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="settings-open-store"
              onClick={(event) => {
                event.preventDefault();
                openStorefrontRoute();
              }}
              className="inline-flex h-10 items-center rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              {t("online.settings.openStore")}
            </a>
            <Button variant="secondary" disabled={!dirty} onClick={() => setDraft(saved)}>
              {t("common.discard")}
            </Button>
            <Button onClick={() => void save()} loading={saving} disabled={!dirty}>
              {t("common.save")}
            </Button>
          </>
        }
      />

      {meta?.updated_at ? (
        <p className="mb-3 text-xs font-semibold text-slate-500">
          {t("online.settings.lastSaved", {
            when: date(meta.updated_at),
            who: meta.updated_by_name ?? "—",
          })}
          {dirty ? ` · ${t("online.settings.unsaved")}` : ""}
        </p>
      ) : null}

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={`shrink-0 rounded-lg px-4 py-1.5 text-xs font-bold transition-all ${
              tab === entry.key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {t(entry.labelKey as never)}
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          {tab === "theme" ? (
            <>
              <Card className="space-y-3">
                <h2 className="text-sm font-bold text-slate-900">{t("online.settings.branding")}</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <SettingsImageField
                    label={t("online.settings.logo")}
                    hint={t("online.settings.logoHint")}
                    value={draft.images.logo_url}
                    previewClass="h-20 w-full"
                    onChange={(url) => patch((current) => ({ ...current, images: { ...current.images, logo_url: url } }))}
                  />
                  <SettingsImageField
                    label={t("online.settings.favicon")}
                    hint={t("online.settings.faviconHint")}
                    value={draft.images.favicon_url}
                    previewClass="h-20 w-full"
                    onChange={(url) => patch((current) => ({ ...current, images: { ...current.images, favicon_url: url } }))}
                  />
                  <SettingsImageField
                    label={t("online.settings.background")}
                    hint={t("online.settings.backgroundHint")}
                    value={draft.images.background_url}
                    onChange={(url) => patch((current) => ({ ...current, images: { ...current.images, background_url: url } }))}
                  />
                  <SettingsImageField
                    label={t("online.settings.aboutImage")}
                    value={draft.images.about_image_url}
                    onChange={(url) => patch((current) => ({ ...current, images: { ...current.images, about_image_url: url } }))}
                  />
                </div>
              </Card>

              <Card className="space-y-3">
                <h2 className="text-sm font-bold text-slate-900">{t("online.settings.colors")}</h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {(
                    [
                      ["primary_color", t("online.settings.primaryColor")],
                      ["secondary_color", t("online.settings.secondaryColor")],
                      ["accent_color", t("online.settings.accentColor")],
                      ["background_color", t("online.settings.backgroundColor")],
                      ["surface_color", t("online.settings.surfaceColor")],
                      ["text_color", t("online.settings.textColor")],
                      ["muted_text_color", t("online.settings.mutedColor")],
                    ] as [keyof WebsiteSettings["theme"], string][]
                  ).map(([field, label]) => (
                    <Field key={field} label={label}>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={String(draft.theme[field])}
                          onChange={(event) =>
                            patch((current) => ({
                              ...current,
                              theme: { ...current.theme, [field]: event.target.value },
                            }))
                          }
                          className="h-10 w-12 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
                          aria-label={label}
                        />
                        <TextInput
                          value={String(draft.theme[field])}
                          onChange={(event) =>
                            patch((current) => ({
                              ...current,
                              theme: { ...current.theme, [field]: event.target.value },
                            }))
                          }
                          className="font-mono text-xs"
                          dir="ltr"
                          aria-label={label}
                        />
                      </div>
                    </Field>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-slate-500">{t("online.settings.colorHint")}</p>
              </Card>

              <Card className="space-y-3">
                <h2 className="text-sm font-bold text-slate-900">{t("online.settings.typography")}</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("online.settings.fontStack")}>
                    <SelectInput
                      value={draft.theme.font_stack}
                      onChange={(event) =>
                        patch((current) => ({
                          ...current,
                          theme: { ...current.theme, font_stack: event.target.value as WebsiteSettings["theme"]["font_stack"] },
                        }))
                      }
                    >
                      {STORE_FONT_STACKS.map((key) => (
                        <option key={key} value={key}>
                          {t(`online.font.${key}`)}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label={t("online.settings.buttonStyle")}>
                    <SelectInput
                      value={draft.theme.button_style}
                      onChange={(event) =>
                        patch((current) => ({
                          ...current,
                          theme: { ...current.theme, button_style: event.target.value as WebsiteSettings["theme"]["button_style"] },
                        }))
                      }
                    >
                      {BUTTON_STYLES.map((key) => (
                        <option key={key} value={key}>
                          {t(`online.buttonStyle.${key}`)}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label={t("online.settings.headerStyle")}>
                    <SelectInput
                      value={draft.theme.header_style}
                      onChange={(event) =>
                        patch((current) => ({
                          ...current,
                          theme: { ...current.theme, header_style: event.target.value as WebsiteSettings["theme"]["header_style"] },
                        }))
                      }
                    >
                      {HEADER_STYLES.map((key) => (
                        <option key={key} value={key}>
                          {t(`online.headerStyle.${key}`)}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label={t("online.settings.cornerRadius")} hint={t("online.settings.cornerRadiusHint")}>
                    <TextInput
                      type="number"
                      min={0}
                      max={32}
                      value={String(draft.theme.corner_radius)}
                      onChange={(event) =>
                        patch((current) => ({
                          ...current,
                          theme: {
                            ...current.theme,
                            corner_radius: Math.max(0, Math.min(32, Number(event.target.value) || 0)),
                          },
                        }))
                      }
                    />
                  </Field>
                </div>
                <ToggleSwitch
                  checked={draft.theme.dark_mode}
                  onChange={(checked) =>
                    patch((current) => ({ ...current, theme: { ...current.theme, dark_mode: checked } }))
                  }
                  label={t("online.settings.darkMode")}
                  hint={t("online.settings.darkModeHint")}
                />
              </Card>

              <Card className="space-y-3">
                <h2 className="text-sm font-bold text-slate-900">{t("online.settings.announcement")}</h2>
                <ToggleSwitch
                  checked={draft.announcement.enabled}
                  onChange={(checked) =>
                    patch((current) => ({ ...current, announcement: { ...current.announcement, enabled: checked } }))
                  }
                  label={t("online.settings.announcementEnabled")}
                  hint={t("online.settings.announcementHint")}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("online.settings.textAr")}>
                    <TextInput
                      value={draft.announcement.text_ar}
                      dir="rtl"
                      onChange={(event) =>
                        patch((current) => ({
                          ...current,
                          announcement: { ...current.announcement, text_ar: event.target.value },
                        }))
                      }
                    />
                  </Field>
                  <Field label={t("online.settings.textEn")}>
                    <TextInput
                      value={draft.announcement.text_en}
                      dir="ltr"
                      onChange={(event) =>
                        patch((current) => ({
                          ...current,
                          announcement: { ...current.announcement, text_en: event.target.value },
                        }))
                      }
                    />
                  </Field>
                  <Field label={t("online.settings.announcementLink")} className="sm:col-span-2">
                    <TextInput
                      value={draft.announcement.href}
                      dir="ltr"
                      onChange={(event) =>
                        patch((current) => ({
                          ...current,
                          announcement: { ...current.announcement, href: event.target.value },
                        }))
                      }
                      placeholder="#/store/products"
                    />
                  </Field>
                </div>
              </Card>
            </>
          ) : null}

          {tab === "sections" ? (
            <>
              <div data-testid="section-content-settings">
                <SectionContentPanel
                  patch={patch}
                  sections={sections}
                  categories={categories.map((category) => ({
                    id: category.id,
                    name_ar: category.name_ar,
                    name_en: category.name_en,
                    active: category.active,
                  }))}
                  products={products.map((product) => ({
                    id: product.id,
                    name_ar: product.name_ar,
                    name_en: product.name_en,
                  }))}
                />
              </div>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-bold text-slate-900">{t("online.settings.sections")}</h2>
                  <Button size="sm" variant="secondary" onClick={() => updateSection(resetSections(draft))}>
                    {t("online.settings.resetSections")}
                  </Button>
                </div>
                <p className="text-[11px] leading-relaxed text-slate-500">{t("online.settings.sectionsHint")}</p>

                <ol className="space-y-2">
                  {sections.map((section, index) => (
                    <li key={section.key} className="rounded-xl border border-slate-200 bg-white p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-bold text-slate-900">
                          <span className="me-2 font-mono text-xs text-slate-400">{index + 1}</span>
                          {t(sectionTitleKey(section.key) as never)}
                        </p>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={index === 0}
                            onClick={() => updateSection(moveSection(draft, index, index - 1))}
                            aria-label={t("online.settings.moveUp")}
                          >
                            ↑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={index === sections.length - 1}
                            onClick={() => updateSection(moveSection(draft, index, index + 1))}
                            aria-label={t("online.settings.moveDown")}
                          >
                            ↓
                          </Button>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={section.visible}
                            onClick={() => updateSection(setSectionVisible(draft, section.key, !section.visible))}
                            className={`ms-1 h-6 w-11 shrink-0 rounded-full transition-colors ${
                              section.visible ? "bg-emerald-500" : "bg-slate-300"
                            }`}
                            aria-label={t("online.settings.visible")}
                          >
                            <span
                              className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                                section.visible ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0.5"
                              }`}
                            />
                          </button>
                        </div>
                      </div>

                      {section.visible ? (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <TextInput
                            value={section.title_ar}
                            dir="rtl"
                            placeholder={t("online.settings.titleArPlaceholder")}
                            onChange={(event) =>
                              updateSection(
                                setSectionTitle(draft, section.key, {
                                  ar: event.target.value,
                                  en: section.title_en,
                                }),
                              )
                            }
                            className="h-9 text-xs"
                            aria-label={t("online.settings.textAr")}
                          />
                          <TextInput
                            value={section.title_en}
                            dir="ltr"
                            placeholder={t("online.settings.titleEnPlaceholder")}
                            onChange={(event) =>
                              updateSection(
                                setSectionTitle(draft, section.key, {
                                  ar: section.title_ar,
                                  en: event.target.value,
                                }),
                              )
                            }
                            className="h-9 text-xs"
                            aria-label={t("online.settings.textEn")}
                          />
                          {PRODUCT_SECTIONS.includes(section.key) ? (
                            <Field label={t("online.settings.sectionLimit")} className="sm:col-span-2">
                              <TextInput
                                type="number"
                                min={1}
                                max={24}
                                value={String(section.limit)}
                                onChange={(event) =>
                                  updateSection(
                                    setSectionLimit(draft, section.key, Number(event.target.value) || 0),
                                  )
                                }
                                className="h-9 w-24 text-xs"
                              />
                            </Field>
                          ) : null}
                          <div className="sm:col-span-2">
                            <SettingsImageField
                              label={t("online.settings.sectionImage")}
                              hint={t("online.settings.sectionImageHint")}
                              previewClass="h-16 w-full"
                              value={draft.images.section_images[section.key] ?? null}
                              onChange={(url) =>
                                patch((current) => ({
                                  ...current,
                                  images: {
                                    ...current.images,
                                    section_images: { ...current.images.section_images, [section.key]: url },
                                  },
                                }))
                              }
                            />
                          </div>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </Card>

            </>
          ) : null}

          {tab === "hero" ? (
            <>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-bold text-slate-900">{t("online.settings.heroSlides")}</h2>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      patch((current) => ({
                        ...current,
                        images: { ...current.images, hero_slides: [...current.images.hero_slides, emptySlide()] },
                      }))
                    }
                  >
                    {t("online.settings.addSlide")}
                  </Button>
                </div>
                {draft.images.hero_slides.length === 0 ? (
                  <p className="text-xs font-semibold text-slate-500">{t("online.settings.noSlides")}</p>
                ) : null}
                {draft.images.hero_slides.map((slide, index) => (
                  <SlideEditor
                    key={slide.id}
                    slide={slide}
                    index={index}
                    onChange={(next) =>
                      patch((current) => ({
                        ...current,
                        images: {
                          ...current.images,
                          hero_slides: current.images.hero_slides.map((entry) =>
                            entry.id === slide.id ? next : entry,
                          ),
                        },
                      }))
                    }
                    onRemove={() =>
                      patch((current) => ({
                        ...current,
                        images: {
                          ...current.images,
                          hero_slides: current.images.hero_slides.filter((entry) => entry.id !== slide.id),
                        },
                      }))
                    }
                  />
                ))}
              </Card>

            </>
          ) : null}

          {tab === "homepage" ? (
            <>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-bold text-slate-900">{t("online.settings.promoBanners")}</h2>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      patch((current) => ({
                        ...current,
                        images: { ...current.images, promo_banners: [...current.images.promo_banners, emptyBanner()] },
                      }))
                    }
                  >
                    {t("online.settings.addBanner")}
                  </Button>
                </div>
                {draft.images.promo_banners.length === 0 ? (
                  <p className="text-xs font-semibold text-slate-500">{t("online.settings.noBanners")}</p>
                ) : null}
                {draft.images.promo_banners.map((banner) => (
                  <BannerEditor
                    key={banner.id}
                    banner={banner}
                    onChange={(next) =>
                      patch((current) => ({
                        ...current,
                        images: {
                          ...current.images,
                          promo_banners: current.images.promo_banners.map((entry) =>
                            entry.id === banner.id ? next : entry,
                          ),
                        },
                      }))
                    }
                    onRemove={() =>
                      patch((current) => ({
                        ...current,
                        images: {
                          ...current.images,
                          promo_banners: current.images.promo_banners.filter((entry) => entry.id !== banner.id),
                        },
                      }))
                    }
                  />
                ))}
              </Card>
            </>
          ) : null}

          {tab === "general" ? (
            <>
              <Card className="space-y-3">
                <h2 className="text-sm font-bold text-slate-900">{t("online.settings.storeInfo")}</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("online.settings.storeNameAr")}>
                    <TextInput
                      value={draft.contact.store_name_ar}
                      dir="rtl"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, store_name_ar: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("online.settings.storeNameEn")}>
                    <TextInput
                      value={draft.contact.store_name_en}
                      dir="ltr"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, store_name_en: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("online.settings.taglineAr")}>
                    <TextInput
                      value={draft.contact.tagline_ar}
                      dir="rtl"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, tagline_ar: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("online.settings.taglineEn")}>
                    <TextInput
                      value={draft.contact.tagline_en}
                      dir="ltr"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, tagline_en: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("export.col.phone")}>
                    <TextInput
                      value={draft.contact.phone}
                      dir="ltr"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, phone: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("online.settings.email")}>
                    <TextInput
                      value={draft.contact.email}
                      dir="ltr"
                      type="email"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, email: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("online.settings.addressAr")}>
                    <TextArea
                      rows={2}
                      value={draft.contact.address_ar}
                      dir="rtl"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, address_ar: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("online.settings.addressEn")}>
                    <TextArea
                      rows={2}
                      value={draft.contact.address_en}
                      dir="ltr"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, address_en: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("online.settings.hoursAr")}>
                    <TextArea
                      rows={2}
                      value={draft.contact.hours_ar}
                      dir="rtl"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, hours_ar: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("online.settings.hoursEn")}>
                    <TextArea
                      rows={2}
                      value={draft.contact.hours_en}
                      dir="ltr"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, hours_en: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("online.settings.mapUrl")} className="sm:col-span-2" hint={t("online.settings.mapUrlHint")}>
                    <TextInput
                      value={draft.contact.map_url}
                      dir="ltr"
                      onChange={(event) => patch((current) => ({ ...current, contact: { ...current.contact, map_url: event.target.value } }))}
                    />
                  </Field>
                </div>
              </Card>

              <Card className="space-y-3">
                <h2 className="text-sm font-bold text-slate-900">{t("online.settings.social")}</h2>
                <p className="text-[11px] leading-relaxed text-slate-500">{t("online.settings.socialHint")}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ["facebook", t("online.settings.facebook"), "https://facebook.com/…"],
                      ["instagram", t("online.settings.instagram"), "https://instagram.com/…"],
                      ["tiktok", t("online.settings.tiktok"), "https://tiktok.com/@…"],
                      ["whatsapp", t("online.settings.whatsapp"), "201001234567"],
                    ] as ["facebook" | "instagram" | "tiktok" | "whatsapp", string, string][]
                  ).map(([field, label, placeholder]) => (
                    <Field key={field} label={label}>
                      <TextInput
                        value={draft.social[field]}
                        dir="ltr"
                        placeholder={placeholder}
                        onChange={(event) =>
                          patch((current) => ({ ...current, social: { ...current.social, [field]: event.target.value } }))
                        }
                      />
                    </Field>
                  ))}
                </div>
              </Card>

              {/* The InstaPay configuration moved to Delivery & pickup → Payment
                  methods, next to the toggles that turn the method on: one place
                  to configure a payment method, instead of its details living in
                  a different tab from its switch. */}
            </>
          ) : null}

          {tab === "categories" ? (
            <div data-testid="categories-content-settings"><CategoriesContentPanel repository={repository} categories={categories} /></div>
          ) : null}

          {tab === "campaigns" ? <div data-testid="campaigns-settings"><CampaignsPanel draft={draft} patch={patch} /></div> : null}

          {tab === "productDisplay" ? <div data-testid="product-display-settings"><ProductDisplayPanel draft={draft} patch={patch} /></div> : null}

          {tab === "productContent" ? (
            <Card className="space-y-3">
              <h2 className="text-sm font-bold text-slate-900">{t("online.ws.productContent")}</h2>
              <p className="text-xs text-slate-500">{t("online.ws.productContentHint")}</p>
              <a
                href="#/online/content"
                className="inline-block rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-700"
              >
                {t("online.ws.openContent")}
              </a>
            </Card>
          ) : null}

          {tab === "header" ? <div data-testid="header-settings"><HeaderPanel draft={draft} patch={patch} /></div> : null}

          {tab === "footer" ? <FooterPanel draft={draft} patch={patch} /> : null}

          {tab === "social" ? <div data-testid="social-settings"><SocialPanel draft={draft} patch={patch} /></div> : null}

          {tab === "checkout" ? <div data-testid="checkout-copy-settings"><CheckoutCopyPanel draft={draft} patch={patch} /></div> : null}

          {tab === "confirmation" ? <div data-testid="confirmation-settings"><ConfirmationPanel draft={draft} patch={patch} /></div> : null}

          {tab === "delivery" ? (
            <Card className="space-y-4">
              <h2 className="text-sm font-bold text-slate-900">{t("online.settings.delivery")}</h2>
              <ToggleSwitch
                checked={draft.delivery.enabled}
                onChange={(checked) => patch((current) => ({ ...current, delivery: { ...current.delivery, enabled: checked } }))}
                label={t("online.settings.deliveryEnabled")}
                hint={t("online.settings.deliveryEnabledHint")}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("online.settings.deliveryFee")} hint={t("online.settings.moneyHint")}>
                  <TextInput
                    type="number"
                    min={0}
                    step="0.01"
                    value={String(draft.delivery.fee)}
                    onChange={(event) =>
                      patch((current) => ({
                        ...current,
                        delivery: { ...current.delivery, fee: Math.max(0, Number(event.target.value) || 0) },
                      }))
                    }
                  />
                </Field>
                <Field label={t("online.settings.freeDeliveryThreshold")} hint={t("online.settings.freeDeliveryHint")}>
                  <TextInput
                    type="number"
                    min={0}
                    step="0.01"
                    value={draft.delivery.free_delivery_threshold === null ? "" : String(draft.delivery.free_delivery_threshold)}
                    placeholder={t("online.settings.neverFree")}
                    onChange={(event) =>
                      patch((current) => ({
                        ...current,
                        delivery: {
                          ...current.delivery,
                          free_delivery_threshold:
                            event.target.value.trim() === "" ? null : Math.max(0, Number(event.target.value) || 0),
                        },
                      }))
                    }
                  />
                </Field>
                <Field label={t("online.settings.minimumOrder")} hint={t("online.settings.minimumOrderHint")}>
                  <TextInput
                    type="number"
                    min={0}
                    step="0.01"
                    value={draft.delivery.minimum_order === null ? "" : String(draft.delivery.minimum_order)}
                    onChange={(event) =>
                      patch((current) => ({
                        ...current,
                        delivery: {
                          ...current.delivery,
                          minimum_order:
                            event.target.value.trim() === "" ? null : Math.max(0, Number(event.target.value) || 0),
                        },
                      }))
                    }
                  />
                </Field>
                <Field label={t("online.settings.deliveryNoteAr")}>
                  <TextArea
                    rows={2}
                    dir="rtl"
                    value={draft.delivery.note_ar}
                    onChange={(event) => patch((current) => ({ ...current, delivery: { ...current.delivery, note_ar: event.target.value } }))}
                  />
                </Field>
                <Field label={t("online.settings.deliveryNoteEn")}>
                  <TextArea
                    rows={2}
                    dir="ltr"
                    value={draft.delivery.note_en}
                    onChange={(event) => patch((current) => ({ ...current, delivery: { ...current.delivery, note_en: event.target.value } }))}
                  />
                </Field>
              </div>

              <div className="space-y-3 border-t border-slate-200 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">{t("online.settings.deliveryAreas")}</h3>
                    <p className="text-[11px] leading-relaxed text-slate-500">
                      {t("online.settings.deliveryAreasHint")}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      patch((current) => ({
                        ...current,
                        delivery: {
                          ...current.delivery,
                          areas: [...current.delivery.areas, { ar: "", en: "" }],
                        },
                      }))
                    }
                  >
                    {t("online.settings.addDeliveryArea")}
                  </Button>
                </div>
                {draft.delivery.areas.map((place, index) => (
                  <div key={index} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <Field label={t("online.settings.deliveryPlaceAr")}>
                      <TextInput
                        dir="rtl"
                        value={place.ar}
                        onChange={(event) =>
                          patch((current) => ({
                            ...current,
                            delivery: {
                              ...current.delivery,
                              areas: current.delivery.areas.map((entry, position) =>
                                position === index ? { ...entry, ar: event.target.value } : entry,
                              ),
                            },
                          }))
                        }
                      />
                    </Field>
                    <Field label={t("online.settings.deliveryPlaceEn")}>
                      <TextInput
                        dir="ltr"
                        value={place.en}
                        onChange={(event) =>
                          patch((current) => ({
                            ...current,
                            delivery: {
                              ...current.delivery,
                              areas: current.delivery.areas.map((entry, position) =>
                                position === index ? { ...entry, en: event.target.value } : entry,
                              ),
                            },
                          }))
                        }
                      />
                    </Field>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        patch((current) => ({
                          ...current,
                          delivery: {
                            ...current.delivery,
                            areas: current.delivery.areas.filter((_entry, position) => position !== index),
                          },
                        }))
                      }
                    >
                      {t("common.delete")}
                    </Button>
                  </div>
                ))}
              </div>

              <ToggleSwitch
                checked={draft.delivery.pickup_enabled}
                onChange={(checked) => patch((current) => ({ ...current, delivery: { ...current.delivery, pickup_enabled: checked } }))}
                label={t("online.settings.pickupEnabled")}
                hint={t("online.settings.pickupEnabledHint")}
              />
              {draft.delivery.pickup_enabled ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("online.settings.pickupAddressAr")}>
                    <TextArea
                      rows={2}
                      dir="rtl"
                      value={draft.delivery.pickup_address_ar}
                      onChange={(event) => patch((current) => ({ ...current, delivery: { ...current.delivery, pickup_address_ar: event.target.value } }))}
                    />
                  </Field>
                  <Field label={t("online.settings.pickupAddressEn")}>
                    <TextArea
                      rows={2}
                      dir="ltr"
                      value={draft.delivery.pickup_address_en}
                      onChange={(event) => patch((current) => ({ ...current, delivery: { ...current.delivery, pickup_address_en: event.target.value } }))}
                    />
                  </Field>
                </div>
              ) : null}

              <h2 className="pt-2 text-sm font-bold text-slate-900">{t("online.settings.paymentMethods")}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <ToggleSwitch
                  checked={draft.delivery.cod_enabled}
                  onChange={(checked) => patch((current) => ({ ...current, delivery: { ...current.delivery, cod_enabled: checked } }))}
                  label={t("online.settings.codEnabled")}
                  hint={t("online.settings.codEnabledHint")}
                />
                <ToggleSwitch
                  checked={draft.delivery.instapay_enabled}
                  onChange={(checked) => patch((current) => ({ ...current, delivery: { ...current.delivery, instapay_enabled: checked } }))}
                  label={t("online.settings.instapayEnabled")}
                  hint={t("online.settings.instapayEnabledHint")}
                />
              </div>
              {!draft.delivery.cod_enabled && !draft.delivery.instapay_enabled ? (
                <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800">
                  {t("online.settings.noPaymentMethod")}
                </p>
              ) : null}

              {draft.delivery.instapay_enabled ? (
                <div className="space-y-3 border-t border-slate-200 pt-3">
                  <h3 className="text-sm font-bold text-slate-900">{t("online.settings.instapay")}</h3>
                  <p className="text-[11px] leading-relaxed text-slate-500">{t("online.settings.instapayHint")}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("online.settings.instapayHolder")}>
                      <TextInput
                        value={draft.social.instapay_holder}
                        placeholder="ALYQ for Accessories"
                        onChange={(event) =>
                          patch((current) => ({ ...current, social: { ...current.social, instapay_holder: event.target.value } }))
                        }
                      />
                    </Field>
                    <Field label={t("online.settings.instapayAccount")}>
                      <TextInput
                        value={draft.social.instapay_account}
                        dir="ltr"
                        placeholder="alyq@instapay"
                        onChange={(event) =>
                          patch((current) => ({ ...current, social: { ...current.social, instapay_account: event.target.value } }))
                        }
                      />
                    </Field>
                    <Field label={t("online.settings.instapayLink")}>
                      <TextInput
                        value={draft.social.instapay_link}
                        dir="ltr"
                        placeholder="https://instapay.eg/…"
                        onChange={(event) =>
                          patch((current) => ({ ...current, social: { ...current.social, instapay_link: event.target.value } }))
                        }
                      />
                    </Field>
                  </div>
                  <SettingsImageField
                    label={t("online.settings.instapayQr")}
                    hint={t("online.settings.instapayQrHint")}
                    previewClass="h-32 w-32"
                    value={draft.social.instapay_qr_url}
                    onChange={(url) =>
                      patch((current) => ({ ...current, social: { ...current.social, instapay_qr_url: url } }))
                    }
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("online.settings.instapayInstructionsAr")} hint={t("online.settings.instapayInstructionsHint")}>
                      <TextArea
                        rows={3}
                        dir="rtl"
                        value={draft.delivery.instapay_instructions_ar}
                        onChange={(event) =>
                          patch((current) => ({ ...current, delivery: { ...current.delivery, instapay_instructions_ar: event.target.value } }))
                        }
                      />
                    </Field>
                    <Field label={t("online.settings.instapayInstructionsEn")}>
                      <TextArea
                        rows={3}
                        dir="ltr"
                        value={draft.delivery.instapay_instructions_en}
                        onChange={(event) =>
                          patch((current) => ({ ...current, delivery: { ...current.delivery, instapay_instructions_en: event.target.value } }))
                        }
                      />
                    </Field>
                  </div>
                  <ToggleSwitch
                    checked={draft.delivery.instapay_proof_required}
                    onChange={(checked) =>
                      patch((current) => ({ ...current, delivery: { ...current.delivery, instapay_proof_required: checked } }))
                    }
                    label={t("online.settings.instapayProofRequired")}
                    hint={t("online.settings.instapayProofRequiredHint")}
                  />
                </div>
              ) : null}
            </Card>
          ) : null}

          {tab === "general" ? (
            <Card className="space-y-3">
              <h2 className="text-sm font-bold text-slate-900">{t("online.settings.seo")}</h2>
              <p className="text-[11px] leading-relaxed text-slate-500">{t("online.settings.seoHint")}</p>
              <Field label={t("online.settings.metaTitle")}>
                <TextInput
                  value={draft.seo.meta_title}
                  onChange={(event) => patch((current) => ({ ...current, seo: { ...current.seo, meta_title: event.target.value } }))}
                />
              </Field>
              <Field label={t("online.settings.metaDescription")} hint={t("online.settings.metaDescriptionHint")}>
                <TextArea
                  rows={3}
                  value={draft.seo.meta_description}
                  onChange={(event) => patch((current) => ({ ...current, seo: { ...current.seo, meta_description: event.target.value } }))}
                />
              </Field>
              <Field label={t("online.settings.keywords")} hint={t("online.settings.keywordsHint")}>
                <TextInput
                  value={draft.seo.keywords}
                  onChange={(event) => patch((current) => ({ ...current, seo: { ...current.seo, keywords: event.target.value } }))}
                />
              </Field>
              <SettingsImageField
                label={t("online.settings.ogImage")}
                hint={t("online.settings.ogImageHint")}
                value={draft.seo.og_image_url}
                onChange={(url) => patch((current) => ({ ...current, seo: { ...current.seo, og_image_url: url } }))}
              />
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const xml = buildSitemapXml({
                      baseUrl,
                      pages: storefrontSitemapPages({ settings: draft, products, contents }),
                    });
                    downloadTextFile("sitemap.xml", xml, "application/xml");
                    toast.success(t("online.settings.sitemapDownloaded"));
                  }}
                >
                  {t("online.settings.downloadSitemap")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    downloadTextFile("robots.txt", buildRobotsTxt(baseUrl));
                    toast.success(t("online.settings.robotsDownloaded"));
                  }}
                >
                  {t("online.settings.downloadRobots")}
                </Button>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">{t("online.settings.sitemapHint")}</p>
              <Field label={t("online.settings.productSeo")} hint={t("online.settings.productSeoHint")}>
                <a href="#/online/content" className="text-xs font-bold text-indigo-700 hover:underline">
                  {t("online.settings.openContent")}
                </a>
              </Field>
            </Card>
          ) : null}
        </div>

        {/* live preview */}
        <aside className="xl:sticky xl:top-4 xl:self-start">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
            {t("online.settings.preview")}
          </p>
          <PreviewDeviceSwitcher settings={draft} />
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{t("online.ws.previewNote")}</p>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{t("online.settings.previewHint")}</p>
          <p className="mt-1 text-[11px] font-semibold text-slate-500">
            {t("online.settings.currencyLocked", { currency: draft.currency })}
          </p>
        </aside>
      </div>
    </div>
  );
}

/** One hero slide in the builder. */
function SlideEditor({
  slide,
  index,
  onChange,
  onRemove,
}: {
  slide: HeroSlide;
  index: number;
  onChange: (next: HeroSlide) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-black text-slate-700">
          {t("online.settings.slideNumber", { count: index + 1 })}
        </p>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t("common.delete")}
        </Button>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <TextInput
          value={slide.title_ar}
          dir="rtl"
          placeholder={t("online.settings.slideTitleAr")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...slide, title_ar: event.target.value })}
          aria-label={t("online.settings.slideTitleAr")}
        />
        <TextInput
          value={slide.title_en}
          dir="ltr"
          placeholder={t("online.settings.slideTitleEn")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...slide, title_en: event.target.value })}
          aria-label={t("online.settings.slideTitleEn")}
        />
        <TextInput
          value={slide.subtitle_ar}
          dir="rtl"
          placeholder={t("online.settings.slideSubtitleAr")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...slide, subtitle_ar: event.target.value })}
          aria-label={t("online.settings.slideSubtitleAr")}
        />
        <TextInput
          value={slide.subtitle_en}
          dir="ltr"
          placeholder={t("online.settings.slideSubtitleEn")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...slide, subtitle_en: event.target.value })}
          aria-label={t("online.settings.slideSubtitleEn")}
        />
        <TextInput
          value={slide.cta_label_ar}
          dir="rtl"
          placeholder={t("online.settings.slideCtaAr")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...slide, cta_label_ar: event.target.value })}
          aria-label={t("online.settings.slideCtaAr")}
        />
        <TextInput
          value={slide.cta_label_en}
          dir="ltr"
          placeholder={t("online.settings.slideCtaEn")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...slide, cta_label_en: event.target.value })}
          aria-label={t("online.settings.slideCtaEn")}
        />
        <TextInput
          value={slide.cta_href}
          dir="ltr"
          placeholder="#/store/products"
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...slide, cta_href: event.target.value })}
          aria-label={t("online.settings.slideCtaHref")}
        />
        <SelectInput
          value={slide.align}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...slide, align: event.target.value as HeroSlide["align"] })}
          aria-label={t("online.settings.slideAlign")}
        >
          <option value="start">{t("online.settings.alignStart")}</option>
          <option value="center">{t("online.settings.alignCenter")}</option>
          <option value="end">{t("online.settings.alignEnd")}</option>
        </SelectInput>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <SettingsImageField
          label={t("online.settings.slideImage")}
          previewClass="h-24 w-full"
          value={slide.image_url}
          onChange={(url) => onChange({ ...slide, image_url: url })}
        />
        <SettingsImageField
          label={t("online.s45.imageMobile")}
          previewClass="h-24 w-full"
          value={slide.mobile_image_url ?? null}
          onChange={(url) => onChange({ ...slide, mobile_image_url: url })}
        />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <Field label={t("online.s45.heroOverlay")}>
          <TextInput
            dir="ltr"
            type="number"
            min={0}
            max={100}
            className="h-9 text-xs"
            value={slide.overlay ?? 42}
            onChange={(event) =>
              onChange({ ...slide, overlay: Math.min(100, Math.max(0, Number(event.target.value) || 0)) })
            }
          />
        </Field>
        <Field label={t("online.s45.heroPosition")}>
          <SelectInput
            className="h-9 text-xs"
            value={slide.content_position ?? "center"}
            onChange={(event) =>
              onChange({ ...slide, content_position: event.target.value as HeroSlide["content_position"] })
            }
          >
            <option value="start">{t("online.settings.alignStart")}</option>
            <option value="center">{t("online.settings.alignCenter")}</option>
            <option value="end">{t("online.settings.alignEnd")}</option>
          </SelectInput>
        </Field>
        <Field label={t("online.s45.heroHeight")}>
          <SelectInput
            className="h-9 text-xs"
            value={slide.height ?? "editorial"}
            onChange={(event) => onChange({ ...slide, height: event.target.value as HeroSlide["height"] })}
          >
            <option value="compact">{t("online.s45.heightCompact")}</option>
            <option value="classic">{t("online.s45.heightClassic")}</option>
            <option value="editorial">{t("online.s45.heightEditorial")}</option>
          </SelectInput>
        </Field>
      </div>
    </div>
  );
}

/** One promotional banner in the builder. */
function BannerEditor({
  banner,
  onChange,
  onRemove,
}: {
  banner: PromoBanner;
  onChange: (next: PromoBanner) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-black text-slate-700">{t("online.settings.promoBanner")}</p>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t("common.delete")}
        </Button>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <TextInput
          value={banner.title_ar}
          dir="rtl"
          placeholder={t("online.settings.bannerTitleAr")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...banner, title_ar: event.target.value })}
          aria-label={t("online.settings.bannerTitleAr")}
        />
        <TextInput
          value={banner.title_en}
          dir="ltr"
          placeholder={t("online.settings.bannerTitleEn")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...banner, title_en: event.target.value })}
          aria-label={t("online.settings.bannerTitleEn")}
        />
        <TextInput
          value={banner.caption_ar}
          dir="rtl"
          placeholder={t("online.settings.bannerCaptionAr")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...banner, caption_ar: event.target.value })}
          aria-label={t("online.settings.bannerCaptionAr")}
        />
        <TextInput
          value={banner.caption_en}
          dir="ltr"
          placeholder={t("online.settings.bannerCaptionEn")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...banner, caption_en: event.target.value })}
          aria-label={t("online.settings.bannerCaptionEn")}
        />
        <TextInput
          value={banner.badge_ar}
          dir="rtl"
          placeholder={t("online.settings.bannerBadgeAr")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...banner, badge_ar: event.target.value })}
          aria-label={t("online.settings.bannerBadgeAr")}
        />
        <TextInput
          value={banner.badge_en}
          dir="ltr"
          placeholder={t("online.settings.bannerBadgeEn")}
          className="h-9 text-xs"
          onChange={(event) => onChange({ ...banner, badge_en: event.target.value })}
          aria-label={t("online.settings.bannerBadgeEn")}
        />
        <TextInput
          value={banner.href}
          dir="ltr"
          placeholder="#/store/products"
          className="h-9 text-xs sm:col-span-2"
          onChange={(event) => onChange({ ...banner, href: event.target.value })}
          aria-label={t("online.settings.slideCtaHref")}
        />
      </div>
      <div className="mt-2">
        <SettingsImageField
          label={t("online.settings.bannerImage")}
          previewClass="h-20 w-full"
          value={banner.image_url}
          onChange={(url) => onChange({ ...banner, image_url: url })}
        />
      </div>
    </div>
  );
}


/** Desktop / tablet / mobile preview widths — representative, not exact. */
function PreviewDeviceSwitcher({ settings }: { settings: WebsiteSettings }) {
  const { t } = useI18n();
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const width = device === "desktop" ? "100%" : device === "tablet" ? "42rem" : "24rem";
  return (
    <div>
      <div className="mb-2 flex gap-1 rounded-xl bg-slate-100 p-1">
        {(["desktop", "tablet", "mobile"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setDevice(candidate)}
            className={`flex-1 rounded-lg px-2 py-1 text-[11px] font-bold transition-all ${
              device === candidate ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {t(`online.ws.preview${candidate.charAt(0).toUpperCase()}${candidate.slice(1)}` as never)}
          </button>
        ))}
      </div>
      <div className="mx-auto transition-all" style={{ width, maxWidth: "100%" }}>
        <StorefrontPreview settings={settings} />
      </div>
    </div>
  );
}
