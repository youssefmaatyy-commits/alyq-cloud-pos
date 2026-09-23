/**
 * Phase 45 website-customization panels.
 *
 * One module holds the new WebsiteSettingsPage tab panels — header (with the
 * announcement stage), footer, social, product display, checkout copy,
 * confirmation copy, campaigns, per-section content, hero and the per-category
 * shop-window editor. Every panel edits the same `WebsiteSettings` draft the
 * page already owns (patched through the page's single `patch`), except the
 * category editor, which owns its own table and its own save calls — category
 * content is rows in `storefront_category_content`, not keys in the document.
 *
 * Every URL field in every panel is saved as typed and rendered only after the
 * safe-URL policy (`configuredHref` / `externalHref`) passes it; the panels
 * never strip or "fix" an unsafe value silently — the storefront simply does
 * not render an unsafe link.
 */
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import {
  Button,
  Card,
  ConfirmDialog,
  Field,
  SelectInput,
  TextArea,
  TextInput,
  ToggleSwitch,
  useToast,
} from "@/components/ui";
import { canActAs } from "@/lib/permissions/enforce";
import { useAuth } from "@/lib/auth";
import type { WebsiteRepository } from "@/modules/online/data/repository";
import { toOnlineError } from "@/modules/online/data/repository";
import { SettingsImageField } from "../SettingsImageField";
import type {
  AnnouncementMessage,
  EditorialCampaign,
  FooterPolicyLink,
  HomepageSectionConfig,
  ProductContentMediaItem,
  SocialLinkConfig,
  StorefrontCategoryContent,
  StorefrontCategoryContentDraft,
  WebsiteSettings,
} from "@/modules/online/types";

type Patch = (change: (current: WebsiteSettings) => WebsiteSettings) => void;

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** One bilingual row: Arabic on the right of its sibling, English beside it. */
function Bilingual({
  labelAr,
  labelEn,
  valueAr,
  valueEn,
  onAr,
  onEn,
  multiline = false,
  rows = 3,
}: {
  labelAr: string;
  labelEn: string;
  valueAr: string;
  valueEn: string;
  onAr: (value: string) => void;
  onEn: (value: string) => void;
  multiline?: boolean;
  rows?: number;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={labelAr}>
        {multiline ? (
          <TextArea dir="rtl" rows={rows} value={valueAr} onChange={(event) => onAr(event.target.value)} />
        ) : (
          <TextInput dir="rtl" value={valueAr} onChange={(event) => onAr(event.target.value)} />
        )}
      </Field>
      <Field label={labelEn}>
        {multiline ? (
          <TextArea dir="ltr" rows={rows} value={valueEn} onChange={(event) => onEn(event.target.value)} />
        ) : (
          <TextInput dir="ltr" value={valueEn} onChange={(event) => onEn(event.target.value)} />
        )}
      </Field>
    </div>
  );
}

/** List row shell: order arrows + remove, shared by every list editor. */
function ListRow({
  index,
  count,
  onUp,
  onDown,
  onRemove,
  children,
}: {
  index: number;
  count: number;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex gap-1">
          <Button size="sm" variant="secondary" disabled={index === 0} onClick={onUp} aria-label="up">
            ↑
          </Button>
          <Button size="sm" variant="secondary" disabled={index === count - 1} onClick={onDown} aria-label="down">
            ↓
          </Button>
        </div>
        <Button size="sm" variant="danger" onClick={onRemove}>
          ✕
        </Button>
      </div>
      {children}
    </div>
  );
}

const move = <T,>(list: T[], index: number, delta: number): T[] => {
  const next = [...list];
  const target = index + delta;
  if (target < 0 || target >= next.length) return list;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

// ── header + announcement ───────────────────────────────────────────────────

export function HeaderPanel({ draft, patch }: { draft: WebsiteSettings; patch: Patch }) {
  const { t } = useI18n();
  const header = draft.header;
  const announcement = draft.announcement;
  const messages = announcement.messages ?? [];

  const setMessages = (next: AnnouncementMessage[]) =>
    patch((current) => ({ ...current, announcement: { ...current.announcement, messages: next } }));

  return (
    <div className="space-y-4">
      <Card className="space-y-3" data-testid="header-settings">
        <h2 className="text-sm font-bold text-slate-900">{t("online.s45.header")}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleSwitch
            checked={header.sticky}
            onChange={(value) => patch((c) => ({ ...c, header: { ...c.header, sticky: value } }))}
            label={t("online.s45.headerSticky")}
          />
          <ToggleSwitch
            checked={header.search_enabled}
            onChange={(value) => patch((c) => ({ ...c, header: { ...c.header, search_enabled: value } }))}
            label={t("online.s45.headerSearch")}
          />
          <ToggleSwitch
            checked={header.account_enabled}
            onChange={(value) => patch((c) => ({ ...c, header: { ...c.header, account_enabled: value } }))}
            label={t("online.s45.headerAccount")}
          />
          {/* The cart can be hidden only cosmetically: checkout stays reachable
              from the product page, so the shop cannot be made unusable. */}
          <ToggleSwitch
            checked={header.cart_enabled}
            onChange={(value) => patch((c) => ({ ...c, header: { ...c.header, cart_enabled: value } }))}
            label={t("online.s45.headerCart")}
            hint={t("online.s45.headerCartHint")}
          />
        </div>
      </Card>

      <Card className="space-y-3" data-testid="announcement-settings">
        <h2 className="text-sm font-bold text-slate-900">{t("online.s45.announcement")}</h2>
        <ToggleSwitch
          checked={announcement.enabled}
          onChange={(value) => patch((c) => ({ ...c, announcement: { ...c.announcement, enabled: value } }))}
          label={t("online.s45.announcementEnabled")}
        />
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t("online.s45.announcementMode")}>
            <SelectInput
              value={announcement.mode ?? "rotate"}
              onChange={(event) =>
                patch((c) => ({
                  ...c,
                  announcement: { ...c.announcement, mode: event.target.value as "static" | "rotate" | "scroll" },
                }))
              }
            >
              <option value="static">{t("online.s45.modeStatic")}</option>
              <option value="rotate">{t("online.s45.modeRotate")}</option>
              <option value="scroll">{t("online.s45.modeScroll")}</option>
            </SelectInput>
          </Field>
          <Field label={t("online.s45.announcementBg")}>
            <TextInput
              dir="ltr"
              value={announcement.bg_color ?? ""}
              placeholder="#34393b"
              onChange={(event) =>
                patch((c) => ({ ...c, announcement: { ...c.announcement, bg_color: event.target.value } }))
              }
            />
          </Field>
          <Field label={t("online.s45.announcementText")}>
            <TextInput
              dir="ltr"
              value={announcement.text_color ?? ""}
              placeholder="#f8f9f6"
              onChange={(event) =>
                patch((c) => ({ ...c, announcement: { ...c.announcement, text_color: event.target.value } }))
              }
            />
          </Field>
          <Field label={t("online.s45.announcementInterval")}>
            <TextInput
              dir="ltr"
              type="number"
              min={2000}
              max={15000}
              step={500}
              value={announcement.interval_ms ?? 5000}
              onChange={(event) =>
                patch((c) => ({
                  ...c,
                  announcement: { ...c.announcement, interval_ms: Number(event.target.value) || 5000 },
                }))
              }
            />
          </Field>
        </div>

        <div className="space-y-3">
          {messages.map((message, index) => (
            <ListRow
              key={message.id}
              index={index}
              count={messages.length}
              onUp={() => setMessages(move(messages, index, -1))}
              onDown={() => setMessages(move(messages, index, 1))}
              onRemove={() => setMessages(messages.filter((entry) => entry.id !== message.id))}
            >
              <div className="space-y-2">
                <ToggleSwitch
                  checked={message.enabled}
                  onChange={(value) =>
                    setMessages(messages.map((entry) => (entry.id === message.id ? { ...entry, enabled: value } : entry)))
                  }
                  label={t("online.s45.messageEnabled")}
                />
                <Bilingual
                  labelAr={t("online.s45.messageAr")}
                  labelEn={t("online.s45.messageEn")}
                  valueAr={message.text_ar}
                  valueEn={message.text_en}
                  onAr={(value) =>
                    setMessages(messages.map((entry) => (entry.id === message.id ? { ...entry, text_ar: value } : entry)))
                  }
                  onEn={(value) =>
                    setMessages(messages.map((entry) => (entry.id === message.id ? { ...entry, text_en: value } : entry)))
                  }
                />
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={t("online.s45.href")} hint={t("online.s45.hrefHint")}>
                    <TextInput
                      dir="ltr"
                      value={message.href ?? ""}
                      onChange={(event) =>
                        setMessages(
                          messages.map((entry) =>
                            entry.id === message.id ? { ...entry, href: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={t("online.s45.ctaAr")}>
                    <TextInput
                      dir="rtl"
                      value={message.cta_ar ?? ""}
                      onChange={(event) =>
                        setMessages(
                          messages.map((entry) =>
                            entry.id === message.id ? { ...entry, cta_ar: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={t("online.s45.ctaEn")}>
                    <TextInput
                      dir="ltr"
                      value={message.cta_en ?? ""}
                      onChange={(event) =>
                        setMessages(
                          messages.map((entry) =>
                            entry.id === message.id ? { ...entry, cta_en: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </Field>
                </div>
              </div>
            </ListRow>
          ))}
          <Button
            variant="secondary"
            disabled={messages.length >= 20}
            onClick={() =>
              setMessages([
                ...messages,
                {
                  id: newId(),
                  enabled: true,
                  text_ar: "",
                  text_en: "",
                  href: "",
                  cta_ar: "",
                  cta_en: "",
                },
              ])
            }
          >
            + {t("online.s45.addMessage")}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── footer ──────────────────────────────────────────────────────────────────

export function FooterPanel({ draft, patch }: { draft: WebsiteSettings; patch: Patch }) {
  const { t } = useI18n();
  const footer = draft.footer;
  const policies = footer.policy_links ?? [];

  const setPolicies = (next: FooterPolicyLink[]) =>
    patch((current) => ({ ...current, footer: { ...current.footer, policy_links: next } }));

  return (
    <div className="space-y-4" data-testid="footer-settings">
      <Card className="space-y-3">
        <h2 className="text-sm font-bold text-slate-900">{t("online.s45.footerBrand")}</h2>
        <Bilingual
          labelAr={t("online.s45.footerDescAr")}
          labelEn={t("online.s45.footerDescEn")}
          valueAr={footer.description_ar}
          valueEn={footer.description_en}
          onAr={(value) => patch((c) => ({ ...c, footer: { ...c.footer, description_ar: value } }))}
          onEn={(value) => patch((c) => ({ ...c, footer: { ...c.footer, description_en: value } }))}
          multiline
        />
        <ToggleSwitch
          checked={footer.show_social}
          onChange={(value) => patch((c) => ({ ...c, footer: { ...c.footer, show_social: value } }))}
          label={t("online.s45.footerSocial")}
        />
        <ToggleSwitch
          checked={footer.newsletter_enabled}
          onChange={(value) => patch((c) => ({ ...c, footer: { ...c.footer, newsletter_enabled: value } }))}
          label={t("online.s45.footerNewsletter")}
        />
        {footer.newsletter_enabled ? (
          <Bilingual
            labelAr={t("online.s45.newsletterNoteAr")}
            labelEn={t("online.s45.newsletterNoteEn")}
            valueAr={footer.newsletter_note_ar}
            valueEn={footer.newsletter_note_en}
            onAr={(value) => patch((c) => ({ ...c, footer: { ...c.footer, newsletter_note_ar: value } }))}
            onEn={(value) => patch((c) => ({ ...c, footer: { ...c.footer, newsletter_note_en: value } }))}
          />
        ) : null}
        <Bilingual
          labelAr={t("online.s45.copyrightAr")}
          labelEn={t("online.s45.copyrightEn")}
          valueAr={footer.copyright_ar}
          valueEn={footer.copyright_en}
          onAr={(value) => patch((c) => ({ ...c, footer: { ...c.footer, copyright_ar: value } }))}
          onEn={(value) => patch((c) => ({ ...c, footer: { ...c.footer, copyright_en: value } }))}
        />
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-bold text-slate-900">{t("online.s45.policyLinks")}</h2>
        <div className="space-y-3">
          {policies.map((link, index) => (
            <ListRow
              key={link.id}
              index={index}
              count={policies.length}
              onUp={() => setPolicies(move(policies, index, -1))}
              onDown={() => setPolicies(move(policies, index, 1))}
              onRemove={() => setPolicies(policies.filter((entry) => entry.id !== link.id))}
            >
              <div className="space-y-2">
                <ToggleSwitch
                  checked={link.enabled}
                  onChange={(value) =>
                    setPolicies(policies.map((entry) => (entry.id === link.id ? { ...entry, enabled: value } : entry)))
                  }
                  label={t("online.s45.messageEnabled")}
                />
                <Bilingual
                  labelAr={t("online.s45.labelAr")}
                  labelEn={t("online.s45.labelEn")}
                  valueAr={link.label_ar}
                  valueEn={link.label_en}
                  onAr={(value) =>
                    setPolicies(policies.map((entry) => (entry.id === link.id ? { ...entry, label_ar: value } : entry)))
                  }
                  onEn={(value) =>
                    setPolicies(policies.map((entry) => (entry.id === link.id ? { ...entry, label_en: value } : entry)))
                  }
                />
                <Field label={t("online.s45.href")} hint={t("online.s45.hrefHint")}>
                  <TextInput
                    dir="ltr"
                    value={link.href}
                    onChange={(event) =>
                      setPolicies(
                        policies.map((entry) =>
                          entry.id === link.id ? { ...entry, href: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                </Field>
              </div>
            </ListRow>
          ))}
          <Button
            variant="secondary"
            disabled={policies.length >= 12}
            onClick={() =>
              setPolicies([
                ...policies,
                { id: newId(), enabled: true, label_ar: "", label_en: "", href: "#/store/about" },
              ])
            }
          >
            + {t("online.s45.addPolicy")}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── social ──────────────────────────────────────────────────────────────────

export function SocialPanel({ draft, patch }: { draft: WebsiteSettings; patch: Patch }) {
  const { t } = useI18n();
  const links = draft.social_links ?? [];

  const setLinks = (next: SocialLinkConfig[]) =>
    patch((current) => ({ ...current, social_links: next }));

  const platformLabel = (platform: SocialLinkConfig["platform"]) =>
    ({ instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", whatsapp: "WhatsApp" })[platform];

  return (
    <Card className="space-y-3" data-testid="social-settings">
      <h2 className="text-sm font-bold text-slate-900">{t("online.s45.social")}</h2>
      <p className="text-xs text-slate-500">{t("online.s45.socialHint")}</p>
      <div className="space-y-3">
        {links.map((link) => (
          <div key={link.platform} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">
              {platformLabel(link.platform)}
            </p>
            <div className="space-y-2">
              <ToggleSwitch
                checked={link.enabled}
                onChange={(value) =>
                  setLinks(links.map((entry) => (entry.platform === link.platform ? { ...entry, enabled: value } : entry)))
                }
                label={t("online.s45.messageEnabled")}
              />
              <Field
                label={link.platform === "whatsapp" ? t("online.s45.whatsappNumber") : t("online.s45.profileUrl")}
                hint={link.platform === "whatsapp" ? t("online.s45.whatsappHint") : t("online.s45.urlHint")}
              >
                <TextInput
                  dir="ltr"
                  value={link.url}
                  onChange={(event) =>
                    setLinks(
                      links.map((entry) =>
                        entry.platform === link.platform ? { ...entry, url: event.target.value } : entry,
                      ),
                    )
                  }
                />
              </Field>
              <Bilingual
                labelAr={t("online.s45.labelAr")}
                labelEn={t("online.s45.labelEn")}
                valueAr={link.label_ar}
                valueEn={link.label_en}
                onAr={(value) =>
                  setLinks(links.map((entry) => (entry.platform === link.platform ? { ...entry, label_ar: value } : entry)))
                }
                onEn={(value) =>
                  setLinks(links.map((entry) => (entry.platform === link.platform ? { ...entry, label_en: value } : entry)))
                }
              />
            </div>
          </div>
        ))}
        {links.length === 0 ? (
          <Button
            variant="secondary"
            onClick={() =>
              setLinks(
                (["instagram", "facebook", "tiktok", "whatsapp"] as const).map((platform) => ({
                  platform,
                  enabled: false,
                  url: "",
                  label_ar: "",
                  label_en: "",
                })),
              )
            }
          >
            {t("online.s45.socialInit")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

// ── product display ─────────────────────────────────────────────────────────

export function ProductDisplayPanel({ draft, patch }: { draft: WebsiteSettings; patch: Patch }) {
  const { t } = useI18n();
  const card = draft.product_card;
  const badges = draft.badges;

  return (
    <div className="space-y-4" data-testid="product-display-settings">
      <Card className="space-y-3">
        <h2 className="text-sm font-bold text-slate-900">{t("online.s45.productCard")}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("online.s45.columnsMobile")}>
            <SelectInput
              value={card.mobile_columns}
              onChange={(event) =>
                patch((c) => ({
                  ...c,
                  product_card: { ...c.product_card, mobile_columns: Number(event.target.value) as 1 | 2 | 3 },
                }))
              }
            >
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </SelectInput>
          </Field>
          <Field label={t("online.s45.columnsDesktop")}>
            <SelectInput
              value={card.desktop_columns}
              onChange={(event) =>
                patch((c) => ({
                  ...c,
                  product_card: {
                    ...c.product_card,
                    desktop_columns: Number(event.target.value) as 2 | 3 | 4 | 5 | 6,
                  },
                }))
              }
            >
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
              <option value="6">6</option>
            </SelectInput>
          </Field>
          <Field label={t("online.s45.cardAspect")}>
            <SelectInput
              value={card.aspect}
              onChange={(event) =>
                patch((c) => ({
                  ...c,
                  product_card: { ...c.product_card, aspect: event.target.value as typeof card.aspect },
                }))
              }
            >
              <option value="portrait">{t("online.s45.aspectPortrait")}</option>
              <option value="square">{t("online.s45.aspectSquare")}</option>
              <option value="landscape">{t("online.s45.aspectLandscape")}</option>
            </SelectInput>
          </Field>
          <Field label={t("online.s45.cardFit")}>
            <SelectInput
              value={card.image_fit}
              onChange={(event) =>
                patch((c) => ({
                  ...c,
                  product_card: { ...c.product_card, image_fit: event.target.value as typeof card.image_fit },
                }))
              }
            >
              <option value="cover">{t("online.s45.fitCover")}</option>
              <option value="contain">{t("online.s45.fitContain")}</option>
            </SelectInput>
          </Field>
          <Field label={t("online.s45.cardGap")}>
            <SelectInput
              value={card.gap}
              onChange={(event) =>
                patch((c) => ({
                  ...c,
                  product_card: { ...c.product_card, gap: event.target.value as typeof card.gap },
                }))
              }
            >
              <option value="cozy">{t("online.s45.gapCozy")}</option>
              <option value="normal">{t("online.s45.gapNormal")}</option>
              <option value="airy">{t("online.s45.gapAiry")}</option>
            </SelectInput>
          </Field>
          <Field label={t("online.s45.cardAlign")}>
            <SelectInput
              value={card.text_align}
              onChange={(event) =>
                patch((c) => ({
                  ...c,
                  product_card: { ...c.product_card, text_align: event.target.value as typeof card.text_align },
                }))
              }
            >
              <option value="start">{t("online.s45.alignStart")}</option>
              <option value="center">{t("online.s45.alignCenter")}</option>
            </SelectInput>
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleSwitch
            checked={card.show_price}
            onChange={(value) => patch((c) => ({ ...c, product_card: { ...c.product_card, show_price: value } }))}
            label={t("online.s45.showPrice")}
          />
          <ToggleSwitch
            checked={card.show_badge}
            onChange={(value) => patch((c) => ({ ...c, product_card: { ...c.product_card, show_badge: value } }))}
            label={t("online.s45.showBadge")}
          />
          <ToggleSwitch
            checked={card.show_wishlist}
            onChange={(value) => patch((c) => ({ ...c, product_card: { ...c.product_card, show_wishlist: value } }))}
            label={t("online.s45.showWishlist")}
          />
          <ToggleSwitch
            checked={card.show_quick_add}
            onChange={(value) => patch((c) => ({ ...c, product_card: { ...c.product_card, show_quick_add: value } }))}
            label={t("online.s45.showQuickAdd")}
          />
          <ToggleSwitch
            checked={card.show_swatches}
            onChange={(value) => patch((c) => ({ ...c, product_card: { ...c.product_card, show_swatches: value } }))}
            label={t("online.s45.showSwatches")}
          />
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-bold text-slate-900">{t("online.s45.badges")}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleSwitch
            checked={badges.show_new}
            onChange={(value) => patch((c) => ({ ...c, badges: { ...c.badges, show_new: value } }))}
            label={t("online.s45.badgeNew")}
          />
          <ToggleSwitch
            checked={badges.show_sale}
            onChange={(value) => patch((c) => ({ ...c, badges: { ...c.badges, show_sale: value } }))}
            label={t("online.s45.badgeSale")}
          />
          <ToggleSwitch
            checked={badges.show_best_seller}
            onChange={(value) => patch((c) => ({ ...c, badges: { ...c.badges, show_best_seller: value } }))}
            label={t("online.s45.badgeBest")}
          />
          <ToggleSwitch
            checked={badges.show_limited}
            onChange={(value) => patch((c) => ({ ...c, badges: { ...c.badges, show_limited: value } }))}
            label={t("online.s45.badgeLimited")}
          />
        </div>
      </Card>
    </div>
  );
}

// ── checkout copy ───────────────────────────────────────────────────────────

export function CheckoutCopyPanel({ draft, patch }: { draft: WebsiteSettings; patch: Patch }) {
  const { t } = useI18n();
  const copy = draft.checkout_copy;

  const set = (key: keyof WebsiteSettings["checkout_copy"]) => (value: string) =>
    patch((c) => ({ ...c, checkout_copy: { ...c.checkout_copy, [key]: value } }));

  const pair = (base: string, labelAr: string, labelEn: string, multiline = true) => {
    const arKey = `${base}_ar` as keyof WebsiteSettings["checkout_copy"];
    const enKey = `${base}_en` as keyof WebsiteSettings["checkout_copy"];
    return (
      <Bilingual
        labelAr={labelAr}
        labelEn={labelEn}
        valueAr={copy[arKey] as string}
        valueEn={copy[enKey] as string}
        onAr={set(arKey)}
        onEn={set(enKey)}
        multiline={multiline}
      />
    );
  };

  return (
    <Card className="space-y-4" data-testid="checkout-copy-settings">
      <h2 className="text-sm font-bold text-slate-900">{t("online.s45.checkoutCopy")}</h2>
      <p className="text-xs text-slate-500">{t("online.s45.copyHint")}</p>
      {pair("heading", t("online.s45.headingAr"), t("online.s45.headingEn"), false)}
      {pair("delivery_note", t("online.s45.deliveryNoteAr"), t("online.s45.deliveryNoteEn"))}
      {pair("pickup_note", t("online.s45.pickupNoteAr"), t("online.s45.pickupNoteEn"))}
      {pair("payment_note", t("online.s45.paymentNoteAr"), t("online.s45.paymentNoteEn"))}
      {pair("cod_note", t("online.s45.codNoteAr"), t("online.s45.codNoteEn"))}
      {pair("instapay_note", t("online.s45.instapayNoteAr"), t("online.s45.instapayNoteEn"))}
      {pair("proof_note", t("online.s45.proofNoteAr"), t("online.s45.proofNoteEn"))}
      <Bilingual
        labelAr={t("online.s45.placeOrderAr")}
        labelEn={t("online.s45.placeOrderEn")}
        valueAr={copy.place_order_ar}
        valueEn={copy.place_order_en}
        onAr={set("place_order_ar")}
        onEn={set("place_order_en")}
        multiline={false}
      />
    </Card>
  );
}

// ── confirmation copy ───────────────────────────────────────────────────────

export function ConfirmationPanel({ draft, patch }: { draft: WebsiteSettings; patch: Patch }) {
  const { t } = useI18n();
  const confirmation = draft.confirmation;

  return (
    <Card className="space-y-4" data-testid="confirmation-settings">
      <h2 className="text-sm font-bold text-slate-900">{t("online.s45.confirmationCopy")}</h2>
      <p className="text-xs text-slate-500">{t("online.s45.confirmationHint")}</p>
      <Bilingual
        labelAr={t("online.s45.headingAr")}
        labelEn={t("online.s45.headingEn")}
        valueAr={confirmation.title_ar}
        valueEn={confirmation.title_en}
        onAr={(value) => patch((c) => ({ ...c, confirmation: { ...c.confirmation, title_ar: value } }))}
        onEn={(value) => patch((c) => ({ ...c, confirmation: { ...c.confirmation, title_en: value } }))}
        multiline={false}
      />
      <Bilingual
        labelAr={t("online.s45.messageAr")}
        labelEn={t("online.s45.messageEn")}
        valueAr={confirmation.message_ar}
        valueEn={confirmation.message_en}
        onAr={(value) => patch((c) => ({ ...c, confirmation: { ...c.confirmation, message_ar: value } }))}
        onEn={(value) => patch((c) => ({ ...c, confirmation: { ...c.confirmation, message_en: value } }))}
      />
      <Bilingual
        labelAr={t("online.s45.guidanceAr")}
        labelEn={t("online.s45.guidanceEn")}
        valueAr={confirmation.guidance_ar}
        valueEn={confirmation.guidance_en}
        onAr={(value) => patch((c) => ({ ...c, confirmation: { ...c.confirmation, guidance_ar: value } }))}
        onEn={(value) => patch((c) => ({ ...c, confirmation: { ...c.confirmation, guidance_en: value } }))}
      />
      <Bilingual
        labelAr={t("online.s45.supportAr")}
        labelEn={t("online.s45.supportEn")}
        valueAr={confirmation.support_cta_ar}
        valueEn={confirmation.support_cta_en}
        onAr={(value) => patch((c) => ({ ...c, confirmation: { ...c.confirmation, support_cta_ar: value } }))}
        onEn={(value) => patch((c) => ({ ...c, confirmation: { ...c.confirmation, support_cta_en: value } }))}
        multiline={false}
      />
      <Field label={t("online.s45.supportHref")} hint={t("online.s45.hrefHint")}>
        <TextInput
          dir="ltr"
          value={confirmation.support_href}
          onChange={(event) =>
            patch((c) => ({ ...c, confirmation: { ...c.confirmation, support_href: event.target.value } }))
          }
        />
      </Field>
      <ToggleSwitch
        checked={confirmation.whatsapp_cta}
        onChange={(value) => patch((c) => ({ ...c, confirmation: { ...c.confirmation, whatsapp_cta: value } }))}
        label={t("online.s45.whatsappCta")}
        hint={t("online.s45.whatsappCtaHint")}
      />
    </Card>
  );
}

// ── editorial campaigns ─────────────────────────────────────────────────────

export function CampaignsPanel({ draft, patch }: { draft: WebsiteSettings; patch: Patch }) {
  const { t } = useI18n();
  const campaigns = draft.campaigns ?? [];

  const setCampaigns = (next: EditorialCampaign[]) =>
    patch((current) => ({ ...current, campaigns: next }));

  const setCampaign = (id: string, change: Partial<EditorialCampaign>) =>
    setCampaigns(campaigns.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)));

  return (
    <Card className="space-y-3" data-testid="campaigns-settings">
      <h2 className="text-sm font-bold text-slate-900">{t("online.s45.campaigns")}</h2>
      <p className="text-xs text-slate-500">{t("online.s45.campaignsHint")}</p>
      <div className="space-y-3">
        {campaigns.map((campaign, index) => (
          <ListRow
            key={campaign.id}
            index={index}
            count={campaigns.length}
            onUp={() => setCampaigns(move(campaigns, index, -1))}
            onDown={() => setCampaigns(move(campaigns, index, 1))}
            onRemove={() => setCampaigns(campaigns.filter((entry) => entry.id !== campaign.id))}
          >
            <div className="space-y-2">
              <ToggleSwitch
                checked={campaign.enabled}
                onChange={(value) => setCampaign(campaign.id, { enabled: value })}
                label={t("online.s45.messageEnabled")}
              />
              <Bilingual
                labelAr={t("online.s45.headingAr")}
                labelEn={t("online.s45.headingEn")}
                valueAr={campaign.title_ar}
                valueEn={campaign.title_en}
                onAr={(value) => setCampaign(campaign.id, { title_ar: value })}
                onEn={(value) => setCampaign(campaign.id, { title_en: value })}
                multiline={false}
              />
              <Bilingual
                labelAr={t("online.s45.subtitleAr")}
                labelEn={t("online.s45.subtitleEn")}
                valueAr={campaign.subtitle_ar}
                valueEn={campaign.subtitle_en}
                onAr={(value) => setCampaign(campaign.id, { subtitle_ar: value })}
                onEn={(value) => setCampaign(campaign.id, { subtitle_en: value })}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <SettingsImageField
                  label={t("online.s45.imageDesktop")}
                  value={campaign.desktop_image_url}
                  onChange={(url) => setCampaign(campaign.id, { desktop_image_url: url })}
                />
                <SettingsImageField
                  label={t("online.s45.imageMobile")}
                  value={campaign.mobile_image_url}
                  onChange={(url) => setCampaign(campaign.id, { mobile_image_url: url })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t("online.s45.ctaAr")}>
                  <TextInput
                    dir="rtl"
                    value={campaign.cta_ar}
                    onChange={(event) => setCampaign(campaign.id, { cta_ar: event.target.value })}
                  />
                </Field>
                <Field label={t("online.s45.ctaEn")}>
                  <TextInput
                    dir="ltr"
                    value={campaign.cta_en}
                    onChange={(event) => setCampaign(campaign.id, { cta_en: event.target.value })}
                  />
                </Field>
                <Field label={t("online.s45.href")} hint={t("online.s45.hrefHint")}>
                  <TextInput
                    dir="ltr"
                    value={campaign.cta_href}
                    onChange={(event) => setCampaign(campaign.id, { cta_href: event.target.value })}
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t("online.s45.startsAt")}>
                  <TextInput
                    dir="ltr"
                    type="datetime-local"
                    value={campaign.starts_at ? campaign.starts_at.slice(0, 16) : ""}
                    onChange={(event) =>
                      setCampaign(campaign.id, { starts_at: event.target.value ? new Date(event.target.value).toISOString() : null })
                    }
                  />
                </Field>
                <Field label={t("online.s45.endsAt")}>
                  <TextInput
                    dir="ltr"
                    type="datetime-local"
                    value={campaign.ends_at ? campaign.ends_at.slice(0, 16) : ""}
                    onChange={(event) =>
                      setCampaign(campaign.id, { ends_at: event.target.value ? new Date(event.target.value).toISOString() : null })
                    }
                  />
                </Field>
                <Field label={t("online.campaign.layout")}>
                  <SelectInput value={campaign.layout ?? "split"} onChange={(event) => setCampaign(campaign.id, { layout: event.target.value as "full" | "split" | "alternating" })}>
                    <option value="full">{t("online.campaign.full")}</option>
                    <option value="split">{t("online.campaign.split")}</option>
                    <option value="alternating">{t("online.campaign.alternating")}</option>
                  </SelectInput>
                </Field>
                <Field label={t("online.s45.placement")}>
                  <SelectInput
                    value={campaign.placement}
                    onChange={(event) =>
                      setCampaign(campaign.id, { placement: event.target.value as "homepage" | "banner" })
                    }
                  >
                    <option value="homepage">{t("online.s45.placementHomepage")}</option>
                    <option value="banner">{t("online.s45.placementBanner")}</option>
                  </SelectInput>
                </Field>
              </div>
            </div>
          </ListRow>
        ))}
        <Button
          variant="secondary"
          disabled={campaigns.length >= 50}
          onClick={() =>
            setCampaigns([
              ...campaigns,
              {
                id: newId(),
                enabled: true,
                title_ar: "",
                title_en: "",
                subtitle_ar: "",
                subtitle_en: "",
                desktop_image_url: null,
                mobile_image_url: null,
                cta_ar: "",
                cta_en: "",
                cta_href: "",
                starts_at: null,
                ends_at: null,
                placement: "homepage",
                sort_order: campaigns.length + 1,
              },
            ])
          }
        >
          + {t("online.s45.addCampaign")}
        </Button>
      </div>
    </Card>
  );
}

// ── per-section content ─────────────────────────────────────────────────────

export function SectionContentPanel({
  patch,
  sections,
  categories,
  products,
}: {
  patch: Patch;
  sections: HomepageSectionConfig[];
  categories: { id: string; name_ar: string; name_en: string; active: boolean }[];
  products: { id: string; name_ar: string; name_en: string }[];
}) {
  const { t, pick } = useI18n();
  const [openKey, setOpenKey] = useState<string | null>(null);

  const setSection = (key: string, change: Partial<HomepageSectionConfig>) =>
    patch((current) => ({
      ...current,
      sections: current.sections.map((section) => (section.key === key ? { ...section, ...change } : section)),
    }));

  const activeCategories = categories.filter((category) => category.active);

  return (
    <Card className="space-y-2" data-testid="section-content-settings">
      <h2 className="text-sm font-bold text-slate-900">{t("online.s45.sectionContent")}</h2>
      <p className="text-xs text-slate-500">{t("online.s45.sectionContentHint")}</p>
      <div className="space-y-2">
        {sections.map((section) => {
          const open = openKey === section.key;
          const label = pick(section.title_ar, section.title_en) || t(`store.section.${section.key}` as never);
          return (
            <div key={section.key} className="rounded-xl border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => setOpenKey(open ? null : section.key)}
                aria-expanded={open}
                className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-start"
              >
                <span className="text-sm font-bold text-slate-800">{label}</span>
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{section.key}</span>
              </button>
              {open ? (
                <div className="space-y-3 border-t border-slate-100 p-3">
                  {section.key === "categories" ? (
                    <>
                      <Field label={t("online.s45.catLayout")}>
                        <SelectInput
                          value={section.layout ?? "tiles"}
                          onChange={(event) =>
                            setSection("categories", { layout: event.target.value as "tiles" | "carousel" | "editorial" })
                          }
                        >
                          <option value="tiles">{t("online.s45.layoutTiles")}</option>
                          <option value="carousel">{t("online.s45.layoutCarousel")}</option>
                          <option value="editorial">{t("online.s45.layoutEditorial")}</option>
                        </SelectInput>
                      </Field>
                      <p className="text-xs font-semibold text-slate-500">{t("online.s45.catPickHint")}</p>
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {activeCategories.map((category) => {
                          const checked = (section.category_ids ?? []).includes(category.id);
                          return (
                            <label key={category.id} className="flex items-center gap-2 text-sm text-slate-700">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) => {
                                  const ids = section.category_ids ?? [];
                                  setSection("categories", {
                                    category_ids: event.target.checked
                                      ? [...ids, category.id]
                                      : ids.filter((id) => id !== category.id),
                                  });
                                }}
                              />
                              {pick(category.name_ar, category.name_en)}
                            </label>
                          );
                        })}
                      </div>
                    </>
                  ) : null}

                  {["collection", "sale", "featured", "bestSellers", "newArrivals"].includes(section.key) &&
                  ["collection", "sale"].includes(section.key) ? (
                    <>
                      <p className="text-xs font-semibold text-slate-500">{t("online.s45.productPickHint")}</p>
                      <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-xl border border-slate-200 p-2">
                        {products.map((product) => {
                          const checked = (section.product_ids ?? []).includes(product.id);
                          return (
                            <label key={product.id} className="flex items-center gap-2 text-sm text-slate-700">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) => {
                                  const ids = section.product_ids ?? [];
                                  setSection(section.key, {
                                    product_ids: event.target.checked
                                      ? [...ids, product.id]
                                      : ids.filter((id) => id !== product.id),
                                  });
                                }}
                              />
                              {pick(product.name_ar, product.name_en)}
                            </label>
                          );
                        })}
                      </div>
                    </>
                  ) : null}

                  {["editorial", "lookbook", "textImage", "newsletter", "campaigns"].includes(section.key) ? (
                    <>
                      <Bilingual
                        labelAr={t("online.s45.bodyAr")}
                        labelEn={t("online.s45.bodyEn")}
                        valueAr={section.body_ar ?? ""}
                        valueEn={section.body_en ?? ""}
                        onAr={(value) => setSection(section.key, { body_ar: value })}
                        onEn={(value) => setSection(section.key, { body_en: value })}
                        multiline
                        rows={4}
                      />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <SettingsImageField
                          label={t("online.s45.imageDesktop")}
                          value={section.image_url ?? null}
                          onChange={(url) => setSection(section.key, { image_url: url })}
                        />
                        <SettingsImageField
                          label={t("online.s45.imageMobile")}
                          value={section.mobile_image_url ?? null}
                          onChange={(url) => setSection(section.key, { mobile_image_url: url })}
                        />
                      </div>
                      <Bilingual
                        labelAr={t("online.s45.ctaAr")}
                        labelEn={t("online.s45.ctaEn")}
                        valueAr={section.cta_ar ?? ""}
                        valueEn={section.cta_en ?? ""}
                        onAr={(value) => setSection(section.key, { cta_ar: value })}
                        onEn={(value) => setSection(section.key, { cta_en: value })}
                        multiline={false}
                      />
                      <Field label={t("online.s45.href")} hint={t("online.s45.hrefHint")}>
                        <TextInput
                          dir="ltr"
                          value={section.cta_href ?? ""}
                          onChange={(event) => setSection(section.key, { cta_href: event.target.value })}
                        />
                      </Field>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── the per-category shop-window editor ─────────────────────────────────────

export function CategoriesContentPanel({
  repository,
  categories,
}: {
  repository: WebsiteRepository;
  categories: { id: string; name_ar: string; name_en: string; active: boolean }[];
}) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const canManage = canActAs(user, "manage_website");
  const [contents, setContents] = useState<StorefrontCategoryContent[]>([]);
  const [editing, setEditing] = useState<StorefrontCategoryContent | null>(null);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await repository.listCategoryContents();
        if (!cancelled) setContents(rows);
      } catch (caught) {
        if (!cancelled) toast.error(t(`online.error.${toOnlineError(caught).code}`));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository]);

  const byCategory = useMemo(() => {
    const map = new Map<string, StorefrontCategoryContent>();
    for (const row of contents) map.set(row.category_id, row);
    return map;
  }, [contents]);

  const save = async (draft: StorefrontCategoryContentDraft) => {
    try {
      const saved = await repository.saveCategoryContent(draft);
      setContents((current) => {
        const rest = current.filter((row) => row.category_id !== saved.category_id);
        return [...rest, saved];
      });
      setEditing(null);
      toast.success(t("online.settings.saved"));
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    }
  };

  const clear = async (categoryId: string) => {
    try {
      await repository.deleteCategoryContent(categoryId);
      setContents((current) => current.filter((row) => row.category_id !== categoryId));
      setEditing(null);
      setConfirmClear(null);
      toast.success(t("online.settings.saved"));
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    }
  };

  return (
    <Card className="space-y-3" data-testid="categories-content-settings">
      <h2 className="text-sm font-bold text-slate-900">{t("online.s45.categoriesContent")}</h2>
      <p className="text-xs text-slate-500">{t("online.s45.categoriesContentHint")}</p>
      {loading ? (
        <p className="text-xs text-slate-500">{t("common.loading")}</p>
      ) : (
        <div className="space-y-2">
          {categories
            .filter((category) => category.active)
            .map((category) => {
              const content = byCategory.get(category.id) ?? null;
              return (
                <div key={category.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-800">
                      {pick(category.name_ar, category.name_en)}
                    </p>
                    <p className="text-[11px] font-semibold text-slate-400">
                      {content ? t("online.s45.contentSet") : t("online.s45.contentEmpty")}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!canManage}
                      onClick={() =>
                        setEditing(
                          content ?? {
                            id: "",
                            category_id: category.id,
                            title_ar: null,
                            title_en: null,
                            description_ar: null,
                            description_en: null,
                            image_url: null,
                            mobile_image_url: null,
                            homepage_image_url: null,
                            featured: false,
                            sort_order: 0,
                            created_at: "",
                            updated_at: "",
                          },
                        )
                      }
                    >
                      {t("common.edit")}
                    </Button>
                    {content ? (
                      <Button size="sm" variant="danger" disabled={!canManage} onClick={() => setConfirmClear(category.id)}>
                        {t("common.delete")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {editing ? (
        <CategoryContentEditor
          category={categories.find((category) => category.id === editing.category_id) ?? null}
          value={editing}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={() => void save({ ...editing })}
        />
      ) : null}

      <ConfirmDialog
        open={confirmClear !== null}
        title={t("online.s45.clearContentTitle")}
        body={t("online.s45.clearContentMessage")}
        tone="danger"
        confirmLabel={t("common.delete")}
        onConfirm={() => confirmClear && void clear(confirmClear)}
        onCancel={() => setConfirmClear(null)}
      />
    </Card>
  );
}

function CategoryContentEditor({
  category,
  value,
  onChange,
  onCancel,
  onSave,
}: {
  category: { name_ar: string; name_en: string } | null;
  value: StorefrontCategoryContent;
  onChange: (next: StorefrontCategoryContent) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const set = (change: Partial<StorefrontCategoryContent>) => onChange({ ...value, ...change });

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs font-bold text-slate-700">
        {category ? `${category.name_ar} / ${category.name_en}` : ""}
      </p>
      <Bilingual
        labelAr={t("online.s45.titleAr")}
        labelEn={t("online.s45.titleEn")}
        valueAr={value.title_ar ?? ""}
        valueEn={value.title_en ?? ""}
        onAr={(v) => set({ title_ar: v || null })}
        onEn={(v) => set({ title_en: v || null })}
        multiline={false}
      />
      <Bilingual
        labelAr={t("online.s45.descAr")}
        labelEn={t("online.s45.descEn")}
        valueAr={value.description_ar ?? ""}
        valueEn={value.description_en ?? ""}
        onAr={(v) => set({ description_ar: v || null })}
        onEn={(v) => set({ description_en: v || null })}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <SettingsImageField
          label={t("online.s45.imageHomepage")}
          value={value.homepage_image_url}
          onChange={(url) => set({ homepage_image_url: url })}
        />
        <SettingsImageField
          label={t("online.s45.imageDesktop")}
          value={value.image_url}
          onChange={(url) => set({ image_url: url })}
        />
        <SettingsImageField
          label={t("online.s45.imageMobile")}
          value={value.mobile_image_url}
          onChange={(url) => set({ mobile_image_url: url })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ToggleSwitch
          checked={value.featured}
          onChange={(v) => set({ featured: v })}
          label={t("online.s45.featured")}
          hint={t("online.s45.featuredHint")}
        />
        <Field label={t("online.s45.sortOrder")}>
          <TextInput
            dir="ltr"
            type="number"
            value={value.sort_order}
            onChange={(event) => set({ sort_order: Number(event.target.value) || 0 })}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button onClick={onSave}>{t("common.save")}</Button>
      </div>
    </div>
  );
}

// ── product media (shared by the product-content editor) ────────────────────

export function MediaListEditor({
  media,
  onChange,
}: {
  media: ProductContentMediaItem[];
  onChange: (next: ProductContentMediaItem[]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      {media.map((item, index) => (
        <ListRow
          key={`${item.url}-${index}`}
          index={index}
          count={media.length}
          onUp={() => onChange(move(media, index, -1))}
          onDown={() => onChange(move(media, index, 1))}
          onRemove={() => onChange(media.filter((_, i) => i !== index))}
        >
          <div className="space-y-2">
            <SettingsImageField
              label={t("online.s45.mediaImage")}
              value={item.url}
              onChange={(url) => onChange(media.map((entry, i) => (i === index ? { ...entry, url: url ?? "" } : entry)))}
            />
            <Bilingual
              labelAr={t("online.s45.altAr")}
              labelEn={t("online.s45.altEn")}
              valueAr={item.alt_ar}
              valueEn={item.alt_en}
              onAr={(v) => onChange(media.map((entry, i) => (i === index ? { ...entry, alt_ar: v } : entry)))}
              onEn={(v) => onChange(media.map((entry, i) => (i === index ? { ...entry, alt_en: v } : entry)))}
              multiline={false}
            />
            <Field label={t("online.s45.mediaKind")}>
              <SelectInput
                value={item.kind}
                onChange={(event) =>
                  onChange(media.map((entry, i) => (i === index ? { ...entry, kind: event.target.value as "product" | "lifestyle" } : entry)))
                }
              >
                <option value="product">{t("online.s45.kindProduct")}</option>
                <option value="lifestyle">{t("online.s45.kindLifestyle")}</option>
              </SelectInput>
            </Field>
          </div>
        </ListRow>
      ))}
      <Button
        variant="secondary"
        disabled={media.length >= 12}
        onClick={() =>
          onChange([...media, { url: "", alt_ar: "", alt_en: "", kind: "product", sort_order: media.length + 1 } as ProductContentMediaItem])
        }
      >
        + {t("online.s45.addMedia")}
      </Button>
    </div>
  );
}
