/** V2-only overrides live alongside the existing website editor, never in a
 * second CMS. Shared content is linked, not copied into V2's settings group. */
import { useState, type ReactNode } from "react";
import { Button, Card, Field, SelectInput, TextInput, ToggleSwitch } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { TranslationKey } from "@/lib/i18n/dictionary";
import type { StorefrontV2Settings, WebsiteSettings } from "../../types";
import { V2_BODY_FONTS, V2_DISPLAY_FONTS, V2_BADGE_STYLES, V2_BUTTON_STYLES } from "../../types";
import {
  DEFAULT_STOREFRONT_V2_SETTINGS, invalidSettingsColor, safeImageField, safeV2Color,
  type V2ColorField,
} from "../../services/settingsDefaults";
import { adaptV2Appearance, contrastRatio } from "../../v2/appearance";
import { SettingsImageField } from "./SettingsImageField";
import { SocialPanel } from "./website/WebsiteTabPanels";

type SharedTab = "general" | "theme" | "hero" | "sections" | "header" | "productDisplay" | "footer" | "social";

function ColorOverride({ field, label, value, inherited, onChange }: {
  field: V2ColorField;
  label: string;
  value: string | null;
  inherited: string;
  onChange: (next: string | null) => void;
}) {
  const { t } = useI18n();
  const valid = value === null || Boolean(safeV2Color(value, ""));
  const fallback = safeV2Color(inherited, "#202427");
  const forPicker = safeV2Color(value, fallback);
  const pickerHex = forPicker.length === 4 ? `#${[...forPicker.slice(1)].map((char) => char + char).join("")}` : forPicker;
  return <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid={`v2-color-${field}`}>
    <label htmlFor={`v2-hex-${field}`} className="block text-xs font-bold text-slate-800">{label}</label>
    <div className="mt-2 flex items-center gap-2">
      <input type="color" value={pickerHex} aria-label={`${label} — ${t("online.v2.picker")}`}
        className="h-10 w-11 shrink-0 cursor-pointer rounded border border-slate-300 bg-white p-1"
        onChange={(event) => onChange(event.target.value)} />
      <TextInput id={`v2-hex-${field}`} data-testid={`v2-hex-${field}`} dir="ltr"
        value={value ?? ""} placeholder={fallback} aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value)} className="min-w-0 font-mono text-xs" />
      <Button variant="ghost" size="sm" disabled={value === null} onClick={() => onChange(null)}
        aria-label={`${t("online.v2.inherit")} ${label}`}>{t("online.v2.resetField")}</Button>
    </div>
    {value === null ? <span className="mt-1 block text-[11px] text-slate-500">{t("online.v2.inherited")}: {fallback}</span> : null}
    {!valid ? <span role="alert" className="mt-1 block text-xs font-semibold text-rose-700">
      {t("online.v2.invalidColor")}</span> : null}
  </div>;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const { t } = useI18n();
  return <Card className="space-y-3">
    <div><span className="inline-block rounded-full bg-slate-900 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
      {t("online.v2.only")}</span>
      <h3 className="mt-2 text-sm font-black text-slate-900">{title}</h3>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-slate-600">{hint}</p> : null}</div>
    {children}
  </Card>;
}

export function StorefrontV2Studio({ draft, patch, onOpenShared }: {
  draft: WebsiteSettings;
  patch: (change: (current: WebsiteSettings) => WebsiteSettings) => void;
  onOpenShared: (tab: SharedTab) => void;
}) {
  const { t } = useI18n();
  const [resetOpen, setResetOpen] = useState(false);
  const [invalidImage, setInvalidImage] = useState(false);
  const v2 = draft.storefront_v2;
  const invalidColor = invalidSettingsColor(draft);
  const appearance = adaptV2Appearance(draft);
  const tokens = appearance.variables as Record<string, string>;
  const set = <K extends keyof StorefrontV2Settings>(key: K, value: StorefrontV2Settings[K]) =>
    patch((current) => ({ ...current, storefront_v2: { ...current.storefront_v2, [key]: value } }));
  const color = (key: V2ColorField, label: string, inherited: string) =>
    <ColorOverride key={key} field={key} label={label} value={v2[key]} inherited={inherited}
      onChange={(value) => set(key, value)} />;
  const size = (key: "logo_height" | "mobile_logo_height", max: number, label: string) =>
    <Field label={label} htmlFor={`v2-${key}`} hint={`${t("online.v2.sizeHint")} · 20–${max}px`}>
      <TextInput id={`v2-${key}`} type="number" min={20} max={max} step={1} dir="ltr"
        data-testid={`v2-${key}`} value={v2[key] ?? ""} placeholder="38"
        onChange={(event) => {
          const raw = event.target.value;
          set(key, raw === "" ? null : Math.max(20, Math.min(max, Math.round(Number(raw) || 38))));
        }} />
    </Field>;
  const selectToggle = (key: "sticky_header" | "show_search" | "show_account" | "show_cart", label: string) =>
    <Field label={label} htmlFor={`v2-${key}`} key={key}>
      <SelectInput id={`v2-${key}`} value={v2[key] === null ? "inherit" : v2[key] ? "on" : "off"}
        data-testid={`v2-${key}`} onChange={(event) =>
          set(key, event.target.value === "inherit" ? null : event.target.value === "on")}>
        <option value="inherit">{t("online.v2.inherit")}</option>
        <option value="on">{t("online.v2.show")}</option>
        <option value="off">{t("online.v2.hide")}</option>
      </SelectInput>
    </Field>;
  const shared: { tab: SharedTab; title: string; hint: string }[] = [
    { tab: "general", title: t("online.v2.sharedBrand"), hint: t("online.v2.sharedBrandHint") },
    { tab: "theme", title: t("online.v2.sharedTheme"), hint: t("online.v2.sharedThemeHint") },
    { tab: "hero", title: t("online.v2.sharedHero"), hint: t("online.v2.sharedHeroHint") },
    { tab: "header", title: t("online.v2.sharedAnnouncement"), hint: t("online.v2.sharedAnnouncementHint") },
    { tab: "productDisplay", title: t("online.v2.sharedCards"), hint: t("online.v2.sharedCardsHint") },
    { tab: "footer", title: t("online.v2.sharedFooter"), hint: t("online.v2.sharedFooterHint") },
  ];
  const contrasts: { label: string; bg: string; fg: string; requested: string | null }[] = [
    { label: t("online.v2.header"), bg: tokens["--v2-header-bg"], fg: tokens["--v2-header-text"], requested: v2.header_text },
    { label: t("online.v2.button"), bg: tokens["--v2-button-bg"], fg: tokens["--v2-button-text"], requested: v2.button_text },
    { label: t("online.v2.badge"), bg: tokens["--v2-badge-bg"], fg: tokens["--v2-badge-text"], requested: v2.badge_text },
    { label: t("online.v2.footer"), bg: tokens["--v2-footer-bg"], fg: tokens["--v2-footer-text"], requested: v2.footer_text },
    { label: t("online.v2.announcement"), bg: tokens["--v2-announcement-bg"], fg: tokens["--v2-announcement-text"], requested: v2.announcement_text },
  ];

  return <div className="space-y-4" data-testid="v2-studio">
    <Card className="border-slate-900 bg-slate-50">
      <p className="text-xs font-black uppercase tracking-widest text-slate-700">{t("online.v2.title")}</p>
      <h2 className="mt-2 text-lg font-bold text-slate-900">{t("online.v2.heading")}</h2>
      <p className="mt-1 text-sm leading-relaxed text-slate-600">{t("online.v2.intro")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-slate-400 bg-white px-3 py-1 text-[11px] font-bold text-slate-800">{t("online.v2.shared")}</span>
        <span className="rounded-full bg-slate-900 px-3 py-1 text-[11px] font-bold text-white">{t("online.v2.only")}</span>
      </div>
      <p className="mt-2 text-xs text-slate-600">{t("online.v2.saveHint")}</p>
    </Card>

    <Card className="space-y-3">
      <h3 className="text-sm font-black text-slate-900">{t("online.v2.sharedSettings")}</h3>
      <p className="text-xs text-slate-600">{t("online.v2.sharedHint")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {shared.map((item) => <div key={item.tab} className="rounded-lg border border-slate-200 p-3">
          <span className="text-[10px] font-bold uppercase text-slate-500">{t("online.v2.shared")}</span>
          <p className="mt-1 text-xs font-bold text-slate-900">{item.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">{item.hint}</p>
          <Button variant="ghost" size="sm" onClick={() => onOpenShared(item.tab)}>
            {t("online.v2.editShared")}</Button>
        </div>)}
      </div>
    </Card>

    <div data-testid="v2-social-editor">
      <div className="mb-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2">
        <span className="text-[10px] font-bold uppercase text-slate-700">{t("online.v2.shared")}</span>
        <p className="mt-1 text-xs leading-relaxed text-slate-700">{t("online.social.sharedScope")}</p>
      </div>
      <SocialPanel draft={draft} patch={patch} />
      {!draft.footer.show_social ? <p role="status" className="mt-2 text-xs text-slate-700">
        {t("online.social.footerHidden")}{" "}
        <Button variant="ghost" size="sm" onClick={() => onOpenShared("footer")}>
          {t("online.v2.editShared")}: {t("online.v2.sharedFooter")}
        </Button>
      </p> : null}
    </div>

    <Section title={t("online.v2.branding")} hint={t("online.v2.brandingHint")}>
      {size("logo_height", 96, t("online.v2.logoSize"))}
    </Section>

    <Section title={t("online.v2.header")} hint={t("online.v2.headerHint")}>
      <div className="grid gap-2 sm:grid-cols-2">
        {color("header_bg", t("online.v2.headerBg"), draft.theme.secondary_color)}
        {color("header_text", t("online.v2.headerText"), tokens["--v2-header-text"])}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {selectToggle("sticky_header", t("online.s45.headerSticky"))}
        {selectToggle("show_search", t("online.s45.headerSearch"))}
        {selectToggle("show_account", t("online.s45.headerAccount"))}
        {selectToggle("show_cart", t("online.s45.headerCart"))}
      </div>
      <ToggleSwitch checked={v2.show_language} onChange={(checked) => set("show_language", checked)}
        label={t("online.v2.languageToggle")} hint={t("online.v2.languageHint")} />
    </Section>

    <Section title={t("online.v2.palette")} hint={t("online.v2.paletteHint")}>
      <div className="grid gap-2 sm:grid-cols-2">
        {color("page_bg", t("online.v2.pageBg"), draft.theme.background_color)}
        {color("surface_bg", t("online.v2.surfaceBg"), draft.theme.surface_color)}
        {color("text_color", t("online.v2.text"), draft.theme.text_color)}
        {color("muted_text", t("online.v2.muted"), draft.theme.muted_text_color)}
        {color("accent_color", t("online.v2.accent"), draft.theme.accent_color)}
        {color("border_color", t("online.v2.border"), tokens["--v2-border"])}
      </div>
    </Section>

    <Section title={t("online.v2.typography")} hint={t("online.v2.typographyHint")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("online.v2.bodyFont")} htmlFor="v2-body-font">
          <SelectInput id="v2-body-font" data-testid="v2-body-font" value={v2.body_font}
            onChange={(event) => set("body_font", event.target.value as StorefrontV2Settings["body_font"])}>
            {V2_BODY_FONTS.map((key) => <option key={key} value={key}>{t(`online.v2.font.${key}` as TranslationKey)}</option>)}
          </SelectInput>
        </Field>
        <Field label={t("online.v2.displayFont")} htmlFor="v2-display-font">
          <SelectInput id="v2-display-font" data-testid="v2-display-font" value={v2.display_font}
            onChange={(event) => set("display_font", event.target.value as StorefrontV2Settings["display_font"])}>
            {V2_DISPLAY_FONTS.map((key) => <option key={key} value={key}>{t(`online.v2.font.${key}` as TranslationKey)}</option>)}
          </SelectInput>
        </Field>
      </div>
    </Section>

    <Section title={t("online.v2.button")} hint={t("online.v2.buttonHint")}>
      <div className="grid gap-2 sm:grid-cols-2">
        {color("button_bg", t("online.v2.buttonBg"), draft.theme.primary_color)}
        {color("button_text", t("online.v2.buttonText"), tokens["--v2-button-text"])}
      </div>
      <Field label={t("online.v2.buttonStyle")} htmlFor="v2-button-style">
        <SelectInput id="v2-button-style" data-testid="v2-button-style" value={v2.button_style}
          onChange={(event) => set("button_style", event.target.value as StorefrontV2Settings["button_style"])}>
          {V2_BUTTON_STYLES.map((key) => <option key={key} value={key}>{key === "inherit" ? t("online.v2.inherit") : t(`online.buttonStyle.${key}`)}</option>)}
        </SelectInput>
      </Field>
    </Section>

    <Section title={t("online.v2.badge")} hint={t("online.v2.badgeHint")}>
      <div className="grid gap-2 sm:grid-cols-2">
        {color("badge_bg", t("online.v2.badgeBg"), draft.theme.accent_color)}
        {color("badge_text", t("online.v2.badgeText"), tokens["--v2-badge-text"])}
      </div>
      <Field label={t("online.v2.badgeStyle")} htmlFor="v2-badge-style">
        <SelectInput id="v2-badge-style" data-testid="v2-badge-style" value={v2.badge_style}
          onChange={(event) => set("badge_style", event.target.value as StorefrontV2Settings["badge_style"])}>
          {V2_BADGE_STYLES.map((key) => <option key={key} value={key}>{key === "inherit" ? t("online.v2.inherit") : key === "pill" ? t("online.buttonStyle.pill") : t("online.buttonStyle.square")}</option>)}
        </SelectInput>
      </Field>
      <Button size="sm" variant="ghost" onClick={() => onOpenShared("productDisplay")}>{t("online.v2.editShared")}: {t("online.v2.sharedCards")}</Button>
    </Section>

    <Section title={t("online.v2.hero")} hint={t("online.v2.heroHint")}>
      <div className="grid gap-2 sm:grid-cols-2">
        {color("hero_bg", t("online.v2.heroBg"), draft.theme.primary_color)}
        {color("hero_text", t("online.v2.heroText"), tokens["--v2-hero-text"])}
      </div>
      <Button size="sm" variant="ghost" onClick={() => onOpenShared("hero")}>{t("online.v2.editShared")}: {t("online.v2.sharedHero")}</Button>
    </Section>

    <Section title={t("online.v2.announcement")} hint={t("online.v2.announcementHint")}>
      <div className="grid gap-2 sm:grid-cols-2">
        {color("announcement_bg", t("online.v2.announcementBg"), draft.announcement.bg_color ?? draft.theme.secondary_color)}
        {color("announcement_text", t("online.v2.announcementText"), tokens["--v2-announcement-text"])}
      </div>
      <Button size="sm" variant="ghost" onClick={() => onOpenShared("header")}>{t("online.v2.editShared")}: {t("online.v2.sharedAnnouncement")}</Button>
    </Section>

    <Section title={t("online.v2.footer")} hint={t("online.v2.footerHint")}>
      <div className="grid gap-2 sm:grid-cols-2">
        {color("footer_bg", t("online.v2.footerBg"), draft.theme.secondary_color)}
        {color("footer_text", t("online.v2.footerText"), tokens["--v2-footer-text"])}
        {color("footer_link", t("online.v2.footerLink"), tokens["--v2-footer-link"])}
      </div>
      <Button size="sm" variant="ghost" onClick={() => onOpenShared("footer")}>{t("online.v2.editShared")}: {t("online.v2.sharedFooter")}</Button>
    </Section>

    <Section title={t("online.v2.mobileSection")} hint={t("online.v2.mobileHint")}>
      <div role="group" aria-label={t("online.v2.mobileLogo")}>
        <SettingsImageField label={t("online.v2.mobileLogo")} hint={t("online.v2.mobileLogoHint")}
          previewClass="h-20 w-full" value={v2.mobile_logo_url}
          onChange={(url) => {
            const safe = safeImageField(url);
            setInvalidImage(Boolean(url && !safe));
            if (!url || safe) set("mobile_logo_url", safe);
          }} />
      </div>
      {invalidImage ? <p role="alert" className="text-xs font-bold text-rose-700">{t("online.v2.imageError")}</p> : null}
      {size("mobile_logo_height", 64, t("online.v2.mobileLogoSize"))}
      <Field label={t("online.v2.mobileColumns")} htmlFor="v2-mobile-columns" hint={t("online.v2.mobileColumnsHint")}>
        <SelectInput id="v2-mobile-columns" data-testid="v2-mobile-columns" value={v2.mobile_columns ?? "inherit"}
          onChange={(event) => set("mobile_columns", event.target.value === "inherit" ? null : event.target.value === "1" ? 1 : 2)}>
          <option value="inherit">{t("online.v2.inherit")} ({appearance.mobileColumns})</option>
          <option value="1">1</option><option value="2">2</option>
        </SelectInput>
      </Field>
    </Section>

    <Card className="space-y-2">
      <h3 className="text-sm font-black text-slate-900">{t("online.v2.contrastTitle")}</h3>
      <p className="text-xs text-slate-600">{t("online.v2.contrastHint")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {contrasts.map((pair) => <div key={pair.label} className="rounded-lg border px-3 py-2 text-xs font-semibold"
          style={{ background: pair.bg, color: pair.fg, borderColor: pair.fg }}>
          {pair.label} · {contrastRatio(pair.bg, pair.fg).toFixed(1)}:1
          {pair.requested && safeV2Color(pair.requested, "").toLowerCase() !== pair.fg.toLowerCase()
            ? ` · ${t("online.v2.adjusted")}` : ""}
        </div>)}
      </div>
      {invalidColor?.startsWith("storefront_v2.") ? (
        <p role="alert" className="text-sm font-bold text-rose-700" data-testid="v2-invalid-colors">
          {t("online.v2.invalidColor")}</p>
      ) : invalidColor ? (
        <p role="alert" className="text-sm font-bold text-rose-700">
          {t("online.settings.invalidColor")}</p>
      ) : null}
    </Card>

    <Card className="space-y-3 border-amber-200 bg-amber-50">
      <h3 className="text-sm font-black text-slate-900">{t("online.v2.reset")}</h3>
      <p className="text-xs leading-relaxed text-slate-700">{t("online.v2.resetHint")}</p>
      {!resetOpen ? <Button variant="secondary" size="sm" onClick={() => setResetOpen(true)} data-testid="v2-reset-open">
        {t("online.v2.reset")}</Button> : <div role="group" aria-label={t("online.v2.reset")} className="space-y-2">
        <p className="text-xs font-semibold text-amber-950">{t("online.v2.resetConfirm")}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" data-testid="v2-reset-confirm" onClick={() => {
            patch((current) => ({ ...current, storefront_v2: { ...DEFAULT_STOREFRONT_V2_SETTINGS } }));
            setResetOpen(false);
          }}>{t("online.v2.confirmReset")}</Button>
          <Button variant="ghost" size="sm" onClick={() => setResetOpen(false)}>{t("common.cancel")}</Button>
        </div>
      </div>}
    </Card>
  </div>;
}
