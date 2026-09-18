/**
 * The storefront shell — Phase 45's redesigned premium frame.
 *
 * The visual language of the whole shop window: a quiet announcement stage, a
 * centered-wordmark header (hamburger + search on one side, account + cart on
 * the other, exactly the phone pattern the task names, expanding into a
 * conventional premium navigation on desktop), a full-height navigation drawer,
 * and an editorial footer.
 *
 * Everything customer-facing here is driven by the settings document — the
 * announcement messages and their mode, the header's sticky behaviour and
 * which icons it shows, the footer's copy, the social links — so the builder
 * changes the shop without code. Text nodes only: configured strings render as
 * text, configured URLs pass the one safe-URL policy (`externalHref` /
 * `configuredHref` / `whatsappHref`) or render no link at all.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import { useStorefront } from "../../hooks/StorefrontProvider";
import { useStoreCart } from "../../hooks/StoreCartProvider";
import { useStoreAccount } from "../../hooks/StoreAccountProvider";
import { storefrontSurfaceStyle } from "../../services/theme";
import {
  announcementIntervalMs,
  configuredHref,
  externalHref,
  resolvedAnnouncementMessages,
  resolvedSocialLinks,
  activeEditorialCampaigns,
} from "../../services/settingsDefaults";
import type { AnnouncementMessage, SocialLinkConfig } from "../../types";
import { StoreImage } from "./StorePrimitives";

/** `wa.me/<number>?text=…` from whatever the admin typed. */
export function whatsappHref(raw: string, message?: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    // A typed wa.me link goes through the same policy as every other
    // configured URL: normalized, http(s)-only, or no link at all.
    const safe = externalHref(value);
    if (!safe) return null;
    return message ? `${safe}${safe.includes("?") ? "&" : "?"}text=${encodeURIComponent(message)}` : safe;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8) return null;
  const number = digits.startsWith("20") ? digits : `20${digits.replace(/^0/, "")}`;
  return `https://wa.me/${number}${message ? `?text=${encodeURIComponent(message)}` : ""}`;
}

function SocialIcon({ kind }: { kind: "facebook" | "instagram" | "tiktok" | "whatsapp" | "instapay" }) {
  const paths: Record<typeof kind, ReactNode> = {
    facebook: (
      <path
        fill="currentColor"
        d="M13.5 21v-7h2.4l.4-2.9h-2.8V9.2c0-.8.2-1.4 1.4-1.4h1.5V5.2c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.2H8v2.9h2.5V21h3Z"
      />
    ),
    instagram: (
      <path
        fill="currentColor"
        d="M12 8.4A3.6 3.6 0 1 0 12 15.6 3.6 3.6 0 0 0 12 8.4Zm0 5.9a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6Zm4.6-6.1a.9.9 0 1 1-1.8 0 .9.9 0 1 1 1.8 0ZM12 5.2c1.9 0 2.1 0 2.9.1.9 0 1.4.2 1.7.3.4.2.7.4 1 .7.3.3.5.6.7 1 .1.3.3.8.3 1.7.1.8.1 1 .1 2.9s0 2.1-.1 2.9c0 .9-.2 1.4-.3 1.7-.2.4-.4.7-.7 1-.3.3-.6.5-1 .7-.3.1-.8.3-1.7.3-.8.1-1 .1-2.9.1s-2.1 0-2.9-.1c-.9 0-1.4-.2-1.7-.3a2.8 2.8 0 0 1-1-.7 2.8 2.8 0 0 1-.7-1c-.1-.3-.3-.8-.3-1.7-.1-.8-.1-1-.1-2.9s0-2.2.1-3c0-1 .2-1.7.4-2.3.3-.6.6-1.2 1.1-1.7.5-.5 1.1-.8 1.7-1.1.6-.2 1.3-.4 2.3-.4.8-.1 1.1-.1 3-.1s2.2 0 3-.1c1 0 1.7-.2 2.3-.4a4.7 4.7 0 0 0 1.7-1.1c.5-.5.8-1.1 1.1-1.7.2-.6.4-1.3.4-2.3.1-.8.1-1.1.1-3s0-2.2-.1-3c0-1-.2-1.7-.4-2.3a4.7 4.7 0 0 0-1.1-1.7 4.7 4.7 0 0 0-1.7-1.1c-.6-.2-1.3-.4-2.3-.4-.8-.1-1.1-.1-3-.1Z"
      />
    ),
    tiktok: (
      <path
        fill="currentColor"
        d="M16.6 5.8a4.3 4.3 0 0 1-1.1-2.8h-3v12.1a2.5 2.5 0 1 1-1.8-2.4V9.6a5.6 5.6 0 1 0 4.8 5.5V9.4a7.2 7.2 0 0 0 4.1 1.3V7.6a4.3 4.3 0 0 1-3-1.8Z"
      />
    ),
    whatsapp: (
      <path
        fill="currentColor"
        d="M12 3.5a8.4 8.4 0 0 0-7.2 12.7L3.5 20.5l4.4-1.2A8.4 8.4 0 1 0 12 3.5Zm0 15.3a7 7 0 0 1-3.6-1l-.3-.2-2.6.7.7-2.5-.2-.3a7 7 0 1 1 6 3.3Zm3.9-5.2c-.2-.1-1.3-.6-1.5-.7-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a5.7 5.7 0 0 1-2.8-2.5c-.1-.2 0-.4.1-.5l.4-.5c.1-.1.1-.3 0-.4l-.6-1.5c-.1-.3-.3-.3-.5-.3h-.5c-.2 0-.5.1-.7.4-.9 1-.6 2.4.4 3.8a10 10 0 0 0 3.9 3.4c1.4.6 2.5.5 3.3-.1.3-.3.5-.7.5-1.1v-.6c0-.2-.2-.3-.4-.4Z"
      />
    ),
    instapay: (
      <path
        fill="currentColor"
        d="M4 6.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm1 2v7h14v-7H5Zm1.5 1.5h4v1h-4v-1Zm0 2.5h7v1h-7v-1Z"
      />
    ),
  };
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      {paths[kind]}
    </svg>
  );
}

// ── the announcement stage ──────────────────────────────────────────────────

function AnnouncementMessageView({ message }: { message: AnnouncementMessage }) {
  const { t, pick } = useI18n();
  const body = pick(message.text_ar, message.text_en);
  const cta = pick(message.cta_ar, message.cta_en);
  const href = configuredHref(message.href ?? "");
  const label = cta ? `${body} — ${cta}` : body;
  if (!href) return <span className="truncate">{body}</span>;
  const internal = href.startsWith("#");
  return internal ? (
    <Link to={href.slice(1)} className="truncate underline-offset-4 hover:underline">
      {label}
    </Link>
  ) : (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="truncate underline-offset-4 hover:underline"
    >
      {label}
      <span className="sr-only"> {t("common.opensInNewTab")}</span>
    </a>
  );
}

function AnnouncementBar() {
  const { t, pick } = useI18n();
  const { settings } = useStorefront();
  const messages = useMemo(() => resolvedAnnouncementMessages(settings), [settings]);
  const mode = settings.announcement.mode ?? "rotate";
  const interval = announcementIntervalMs(settings);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!settings.announcement.enabled || messages.length < 2 || mode !== "rotate" || paused) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % messages.length), interval);
    return () => window.clearInterval(timer);
  }, [settings.announcement.enabled, messages.length, mode, paused, interval]);

  if (!settings.announcement.enabled) return null;
  const shown = messages.length > 0 ? messages[index % messages.length] : null;
  if (!shown) return null;

  const background = settings.announcement.bg_color?.trim() || "var(--store-secondary)";
  const color =
    settings.announcement.text_color?.trim() || "var(--store-on-secondary)";
  const scrolling = mode === "scroll" && messages.length > 1;

  return (
    <div
      role="region"
      aria-label={t("store.announcements.label")}
      className="relative overflow-hidden px-4 py-2 text-center text-[11px] font-bold tracking-wide"
      style={{ backgroundColor: background, color }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {scrolling ? (
        // A marquee for the scroll mode. Animation is decoration only: with
        // reduced motion (or before hydration) the first message simply shows.
        <div
          className="flex w-max gap-16 whitespace-nowrap motion-reduce:animate-none"
          style={{ animation: "store-marquee 24s linear infinite" }}
        >
          {[...messages, ...messages].map((message, i) => (
            <span key={`${message.id}-${i}`} className="inline-flex items-center gap-2">
              <AnnouncementMessageView message={message} />
            </span>
          ))}
        </div>
      ) : (
        <div
          key={shown.id}
          className="flex items-center justify-center gap-2"
          aria-live="polite"
        >
          <AnnouncementMessageView message={shown} />
          {messages.length > 1 && mode === "rotate" ? (
            <span className="flex gap-1" aria-hidden>
              {messages.map((message, i) => (
                <span
                  key={message.id}
                  className="h-1 w-1 rounded-full"
                  style={{ backgroundColor: color, opacity: i === index % messages.length ? 1 : 0.35 }}
                />
              ))}
            </span>
          ) : null}
        </div>
      )}
      <style>{`@keyframes store-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }`}</style>
      {/* The dot row is decorative; screen readers get the message itself. */}
      <span className="sr-only">
        {pick(settings.announcement.text_ar, settings.announcement.text_en)}
      </span>
    </div>
  );
}

// ── the social row (footer + drawer share it) ───────────────────────────────

export function SocialRow({ size = "md" }: { size?: "sm" | "md" }) {
  const { settings } = useStorefront();
  const { t, lang } = useI18n();
  const links = useMemo(() => resolvedSocialLinks(settings), [settings]);
  if (!settings.footer.show_social) return null;

  const pick2 = (lang2: string, ar: string, en: string) => (lang2 === "ar" ? ar : en) || ar || en;
  const PLATFORM_NAMES: Record<SocialLinkConfig["platform"], string> = {
    instagram: "Instagram",
    facebook: "Facebook",
    tiktok: "TikTok",
    whatsapp: "WhatsApp",
  };
  const render = (config: SocialLinkConfig) => {
    if (!config.enabled) return null;
    const label =
      pick2(lang, config.label_ar, config.label_en) || PLATFORM_NAMES[config.platform];
    if (config.platform === "whatsapp") {
      const href = whatsappHref(config.url, t("store.contact.whatsappMessage"));
      if (!href) return null;
      return (
        <a
          key={config.platform}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={label}
          className={cn(
            "grid place-items-center rounded-full border border-[var(--store-hairline)] text-[var(--store-muted)] transition hover:border-[var(--store-text)] hover:text-[var(--store-text)]",
            size === "sm" ? "h-8 w-8" : "h-9 w-9",
          )}
        >
          <SocialIcon kind="whatsapp" />
        </a>
      );
    }
    const href = externalHref(config.url);
    if (!href) return null;
    return (
      <a
        key={config.platform}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        className={cn(
          "grid place-items-center rounded-full border border-[var(--store-hairline)] text-[var(--store-muted)] transition hover:border-[var(--store-text)] hover:text-[var(--store-text)]",
          size === "sm" ? "h-8 w-8" : "h-9 w-9",
        )}
      >
        <SocialIcon kind={config.platform} />
      </a>
    );
  };

  const rendered = links.map(render).filter(Boolean);
  if (rendered.length === 0) return null;
  return <div className="flex items-center gap-2">{rendered}</div>;
}

// ── the header ──────────────────────────────────────────────────────────────

function Header({
  onMenu,
  menuOpen,
}: {
  onMenu: () => void;
  menuOpen: boolean;
}) {
  const { t, pick, lang, toggleLang } = useI18n();
  const { settings } = useStorefront();
  const { unitCount } = useStoreCart();
  const { customer } = useStoreAccount();
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");

  const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en) || "ALYQ";
  const sticky = settings.header.sticky;

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const query = search.trim();
    setSearchOpen(false);
    navigate(query ? `/store/products?q=${encodeURIComponent(query)}` : "/store/products");
  };

  const iconButton =
    "grid h-10 w-10 place-items-center text-[var(--store-text)] transition hover:text-[var(--store-accent)]";

  return (
    <header
      className={cn(
        "z-40 border-b border-[var(--store-hairline)] bg-[var(--store-surface)]/95 backdrop-blur",
        sticky && "sticky top-0",
      )}
    >
      <div className="mx-auto flex w-full max-w-[var(--store-max-width)] items-center gap-1 px-4 py-2.5 sm:px-6">
        {/* Phase 49, the slim editorial header: one row at every width. On
            phones the left cluster is the hamburger and the search glass; on
            desktop it IS the navigation — the categories and the house pages
            sit left of a centred wordmark, with the utilities right. */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <button
            type="button"
            onClick={onMenu}
            aria-label={t("store.nav.menu")}
            aria-expanded={menuOpen}
            className={cn(iconButton, "lg:hidden")}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
              <path fill="currentColor" d="M4 6h16v1.8H4V6Zm0 5.1h16v1.8H4v-1.8ZM4 16.2h16V18H4v-1.8Z" />
            </svg>
          </button>
          {/* Phase 49 visual pass: the slim editorial nav is the house pages,
              not the category list — categories live in the shop-window tiles,
              the drawer and the footer, where a picture carries them better
              than a word. An accessories house keeps its header quiet. */}
          <nav
            aria-label={t("store.nav.menu")}
            className="hidden min-w-0 items-center gap-x-6 lg:flex"
          >
            <Link
              to="/store/products"
              className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--store-text)] transition hover:text-[var(--store-accent)]"
            >
              {t("store.nav.products")}
            </Link>
            <Link
              to="/store/products?sort=newest"
              className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--store-muted)] transition hover:text-[var(--store-text)]"
            >
              {t("store.nav.new")}
            </Link>
            <Link
              to="/store/about"
              className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--store-muted)] transition hover:text-[var(--store-text)]"
            >
              {t("store.nav.about")}
            </Link>
            <Link
              to="/store/contact"
              className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--store-muted)] transition hover:text-[var(--store-text)]"
            >
              {t("store.nav.contact")}
            </Link>
          </nav>
        </div>

        {/* centre: the wordmark */}
        <Link
          to="/store"
          aria-label={storeName}
          className="flex min-w-0 shrink-0 items-center justify-center"
        >
          {settings.images.logo_url ? (
            <StoreImage
              src={settings.images.logo_url}
              alt={storeName}
              ratio=""
              className="h-9 w-auto bg-transparent"
              sizes="120px"
            />
          ) : (
            <span
              dir="ltr"
              className="block whitespace-nowrap text-center text-xl font-black uppercase leading-none tracking-[0.32em] text-[var(--store-text)]"
              style={{ fontFamily: "var(--store-font-display)" }}
            >
              {storeName}
            </span>
          )}
        </Link>

        {/* right: search + account + cart (+ language) */}
        <div className="flex flex-1 items-center justify-end gap-0.5">
          {settings.header.search_enabled ? (
            <button
              type="button"
              onClick={() => setSearchOpen((open) => !open)}
              aria-label={t("store.search.label")}
              aria-expanded={searchOpen}
              className={iconButton}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
                <path
                  fill="currentColor"
                  d="M10.5 4a6.5 6.5 0 0 1 5.1 10.5l4.2 4.2-1.4 1.4-4.2-4.2A6.5 6.5 0 1 1 10.5 4Zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z"
                />
              </svg>
            </button>
          ) : null}
          {settings.header.account_enabled ? (
            <Link
              to="/store/account"
              className={iconButton}
              aria-label={customer ? t("store.account.title") : t("store.account.signIn")}
              title={customer ? customer.name : t("store.account.signIn")}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
                <path
                  fill="currentColor"
                  d="M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm0 10c4 0 7 2 7 4.5V20H5v-1.5C5 16 8 14 12 14Z"
                />
              </svg>
            </Link>
          ) : null}
          {settings.header.cart_enabled ? (
            <Link to="/store/cart" className={cn(iconButton, "relative")} aria-label={t("store.cart.title")}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
                <path
                  fill="currentColor"
                  d="M7 4h-2l-1 2h2l2.6 9.2A2 2 0 0 0 10.5 17h7.1a2 2 0 0 0 1.9-1.4L21 8H8.6L7.9 5.5A1 1 0 0 0 7 4Zm3.6 15a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm7 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z"
                />
              </svg>
              {unitCount > 0 ? (
                <span
                  aria-label={t("store.cart.itemCount", { count: unitCount })}
                  className="absolute top-1 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-[var(--store-accent)] px-1 text-[10px] font-black leading-none text-[var(--store-on-accent)]"
                  style={{ insetInlineEnd: "0.15rem" }}
                >
                  {unitCount > 99 ? "99+" : unitCount}
                </span>
              ) : null}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={toggleLang}
            className="hidden h-10 items-center px-2 text-[11px] font-bold uppercase tracking-widest text-[var(--store-muted)] transition hover:text-[var(--store-text)] sm:grid"
            aria-label={t("store.nav.changeLanguage")}
          >
            {lang === "en" ? "عربي" : "EN"}
          </button>
        </div>
      </div>

      {/* expanding search row — the glass opens it at every width */}
      {searchOpen && settings.header.search_enabled ? (
        <form
          onSubmit={submitSearch}
          role="search"
          className="border-t border-[var(--store-hairline)] px-4 py-2.5 sm:px-6"
        >
          <input
            // The row exists to be typed into the moment it opens.
            autoFocus
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("store.search.placeholder")}
            aria-label={t("store.search.label")}
            className="w-full border-0 border-b border-[var(--store-hairline)] bg-transparent px-1 py-2 text-sm tracking-wide text-[var(--store-text)] outline-none placeholder:text-[var(--store-muted)] focus:border-[var(--store-text)]"
          />
        </form>
      ) : null}
    </header>
  );
}

// ── the mobile drawer ───────────────────────────────────────────────────────

function MenuDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, pick, lang, toggleLang } = useI18n();
  const { settings, categories, categoryContents, sections } = useStorefront();
  const { customer } = useStoreAccount();
  const navigate = useNavigate();
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    drawerRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const contentBy = new Map(categoryContents.map((row) => [row.category_id, row]));
  const categoriesList = [...categories]
    .sort((a, b) => {
      const ca = contentBy.get(a.id)?.sort_order ?? Number.MAX_SAFE_INTEGER;
      const cb = contentBy.get(b.id)?.sort_order ?? Number.MAX_SAFE_INTEGER;
      return ca - cb || a.sort_order - b.sort_order;
    })
    .slice(0, 12);
  const has = (key: string) => sections.some((s) => s.key === key && s.visible);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  const item =
    "block w-full px-6 py-3 text-start text-sm font-semibold tracking-wide text-[var(--store-text)] transition hover:bg-[var(--store-primary-soft)]";

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={t("store.nav.menu")}>
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
      />
      <div
        ref={drawerRef}
        tabIndex={-1}
        className="absolute inset-y-0 flex w-[86%] max-w-sm flex-col overflow-y-auto bg-[var(--store-surface)] shadow-2xl outline-none"
        style={{ insetInlineStart: 0 }}
      >
        <div className="flex items-center justify-between border-b border-[var(--store-hairline)] px-6 py-4">
          <span
            dir="ltr"
            className="text-base font-black uppercase tracking-[0.3em] text-[var(--store-text)]"
            style={{ fontFamily: "var(--store-font-display)" }}
          >
            {pick(settings.contact.store_name_ar, settings.contact.store_name_en) || "ALYQ"}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="grid h-9 w-9 place-items-center text-[var(--store-muted)] hover:text-[var(--store-text)]"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
              <path
                fill="currentColor"
                d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4 6.4 5Z"
              />
            </svg>
          </button>
        </div>

        <nav className="py-2">
          <button type="button" className={item} onClick={() => go("/store")}>
            {t("store.nav.home")}
          </button>
          <button type="button" className={item} onClick={() => go("/store/products")}>
            {t("store.nav.products")}
          </button>
          {has("newArrivals") ? (
            <button type="button" className={item} onClick={() => go("/store/products?sort=newest")}>
              {t("store.nav.new")}
            </button>
          ) : null}
          {has("bestSellers") ? (
            <button type="button" className={item} onClick={() => go("/store/products?sort=best")}>
              {t("store.section.bestSellers")}
            </button>
          ) : null}

          <p className="px-6 pb-1 pt-5 text-[10px] font-black uppercase tracking-[0.22em] text-[var(--store-muted)]">
            {t("store.nav.categories")}
          </p>
          {categoriesList.map((category) => {
            const content = contentBy.get(category.id) ?? null;
            return (
              <button
                key={category.id}
                type="button"
                className={cn(item, "py-2.5 text-[13px] font-medium text-[var(--store-muted)]")}
                onClick={() => go(`/store/products?category=${encodeURIComponent(category.id)}`)}
              >
                {pick(content?.title_ar ?? category.name_ar, content?.title_en ?? category.name_en)}
              </button>
            );
          })}

          <p className="px-6 pb-1 pt-5 text-[10px] font-black uppercase tracking-[0.22em] text-[var(--store-muted)]">
            {t("store.footer.shop")}
          </p>
          <button type="button" className={item} onClick={() => go("/store/about")}>
            {t("store.nav.about")}
          </button>
          <button type="button" className={item} onClick={() => go("/store/contact")}>
            {t("store.nav.contact")}
          </button>
          <button type="button" className={item} onClick={() => go("/store/track")}>
            {t("store.nav.track")}
          </button>
          <button type="button" className={item} onClick={() => go("/store/account")}>
            {customer ? t("store.account.title") : t("store.account.signIn")}
          </button>
        </nav>

        <div className="mt-auto space-y-4 border-t border-[var(--store-hairline)] px-6 py-5">
          <SocialRow size="sm" />
          <button
            type="button"
            onClick={toggleLang}
            className="text-[11px] font-bold uppercase tracking-widest text-[var(--store-muted)]"
          >
            {lang === "en" ? "العربية" : "English"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── banner campaigns (slim strips under the header) ─────────────────────────

function CampaignBanners() {
  const { pick } = useI18n();
  const { settings } = useStorefront();
  const banners = useMemo(
    () => activeEditorialCampaigns(settings).filter((c) => c.placement === "banner"),
    [settings],
  );
  if (banners.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-[var(--store-max-width)] px-4 pt-4 sm:px-6">
      {banners.slice(0, 2).map((campaign) => {
        const href = configuredHref(campaign.cta_href);
        const body = (
          <div className="flex items-center justify-center gap-3 bg-[var(--store-primary-soft)] px-4 py-2 text-center text-xs font-bold tracking-wide text-[var(--store-text)]">
            <span>{pick(campaign.title_ar, campaign.title_en)}</span>
            {pick(campaign.cta_ar, campaign.cta_en) ? (
              <span className="underline underline-offset-4">
                {pick(campaign.cta_ar, campaign.cta_en)}
              </span>
            ) : null}
          </div>
        );
        return href ? (
          <Link key={campaign.id} to={href.startsWith("#") ? href.slice(1) : href} className="block">
            {body}
          </Link>
        ) : (
          <div key={campaign.id}>{body}</div>
        );
      })}
    </div>
  );
}

// ── the shell ───────────────────────────────────────────────────────────────

export function StoreLayout({ children }: { children: ReactNode }) {
  const { t, dir } = useI18n();
  const { settings } = useStorefront();
  const { whatsapp } = { whatsapp: whatsappHref(settings.social.whatsapp, t("store.contact.whatsappMessage")) };
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.search]);

  return (
    <div
      className="flex min-h-screen flex-col text-[var(--store-text)]"
      style={storefrontSurfaceStyle(settings)}
      dir={dir}
    >
      <AnnouncementBar />
      <Header onMenu={() => setMenuOpen(true)} menuOpen={menuOpen} />
      <CampaignBanners />

      <main className="flex-1">{children}</main>

      <SiteFooter />

      <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />

      {whatsapp ? (
        <a
          href={whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          className="fixed bottom-5 z-40 grid h-13 w-13 place-items-center rounded-full bg-[#25D366] p-3.5 text-white shadow-lg transition hover:scale-105"
          style={{ insetInlineEnd: "1.25rem" }}
          aria-label={t("store.contact.whatsapp")}
        >
          <SocialIcon kind="whatsapp" />
        </a>
      ) : null}
    </div>
  );
}

// ── the footer ──────────────────────────────────────────────────────────────

function SiteFooter() {
  const { t, pick, dir } = useI18n();
  const { settings, sections } = useStorefront();
  const footer = settings.footer;
  const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en) || "ALYQ";
  const description = pick(footer.description_ar, footer.description_en).trim();
  const copyright = pick(footer.copyright_ar, footer.copyright_en).trim();
  const mapLink = externalHref(settings.contact.map_url);
  const policies = (footer.policy_links ?? []).filter((link) => {
    if (!link.enabled || (!link.label_ar.trim() && !link.label_en.trim())) return false;
    return configuredHref(link.href) !== null;
  });

  const email = settings.contact.email.trim();
  const newsletterSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The shop has no mailing-list backend; the honest subscribe is a mail draft
    // to the shop's own address with the customer's address in the body.
    const input = event.currentTarget.elements.namedItem("email") as HTMLInputElement | null;
    const address = input?.value.trim() ?? "";
    if (email && address) {
      window.location.href = `mailto:${email}?subject=${encodeURIComponent(
        "ALYQ newsletter",
      )}&body=${encodeURIComponent(address)}`;
    }
  };

  return (
    <footer className="mt-[var(--store-space-section)] border-t border-[var(--store-hairline)] bg-[var(--store-surface)]">
      {footer.newsletter_enabled ? (
        <div className="border-b border-[var(--store-hairline)]">
          <div className="mx-auto flex w-full max-w-[var(--store-max-width)] flex-col items-center gap-4 px-6 py-10 text-center">
            <p
              className="text-lg font-bold tracking-wide text-[var(--store-text)]"
              style={{ fontFamily: "var(--store-font-display)" }}
            >
              {t("store.footer.newsletterTitle")}
            </p>
            {pick(footer.newsletter_note_ar, footer.newsletter_note_en) ? (
              <p className="max-w-md text-xs leading-relaxed text-[var(--store-muted)]">
                {pick(footer.newsletter_note_ar, footer.newsletter_note_en)}
              </p>
            ) : null}
            <form onSubmit={newsletterSubmit} className="flex w-full max-w-sm items-center gap-2">
              <label className="sr-only" htmlFor="footer-newsletter-email">
                {t("store.footer.emailLabel")}
              </label>
              <input
                id="footer-newsletter-email"
                name="email"
                type="email"
                required
                placeholder={t("store.footer.emailPlaceholder")}
                className="min-w-0 flex-1 border-0 border-b border-[var(--store-hairline)] bg-transparent px-1 py-2 text-sm text-[var(--store-text)] outline-none placeholder:text-[var(--store-muted)] focus:border-[var(--store-text)]"
              />
              <button
                type="submit"
                className="shrink-0 px-4 py-2 text-[11px] font-black uppercase tracking-[0.2em] text-[var(--store-on-primary)] transition hover:opacity-90"
                style={{ backgroundColor: "var(--store-primary)" }}
              >
                {t("store.footer.subscribe")}
              </button>
            </form>
          </div>
        </div>
      ) : null}

      <div className="mx-auto grid w-full max-w-[var(--store-max-width)] gap-10 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p
            dir="ltr"
            className="text-lg font-black uppercase tracking-[0.3em] text-[var(--store-text)]"
            style={{ fontFamily: "var(--store-font-display)" }}
          >
            {storeName}
          </p>
          {description ? (
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-[var(--store-muted)]">{description}</p>
          ) : (
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-[var(--store-muted)]">
              {pick(settings.contact.tagline_ar, settings.contact.tagline_en)}
            </p>
          )}
          <div className="mt-4">
            <SocialRow />
          </div>
        </div>

        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[var(--store-muted)]">
            {t("store.footer.shop")}
          </p>
          <ul className="mt-4 space-y-2.5 text-sm">
            {sections
              .filter((section) => section.visible && ["newArrivals", "bestSellers", "featured"].includes(section.key))
              .map((section) => (
                <li key={section.key}>
                  <Link
                    to={
                      section.key === "newArrivals"
                        ? "/store/products?sort=newest"
                        : section.key === "bestSellers"
                          ? "/store/products?sort=best"
                          : "/store/products"
                    }
                    className="text-[var(--store-muted)] transition hover:text-[var(--store-text)]"
                  >
                    {pick(section.title_ar, section.title_en) || t(`store.section.${section.key}` as never)}
                  </Link>
                </li>
              ))}
            <li>
              <Link to="/store/track" className="text-[var(--store-muted)] transition hover:text-[var(--store-text)]">
                {t("store.nav.track")}
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[var(--store-muted)]">
            {t("store.footer.info")}
          </p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li>
              <Link to="/store/about" className="text-[var(--store-muted)] transition hover:text-[var(--store-text)]">
                {t("store.nav.about")}
              </Link>
            </li>
            <li>
              <Link to="/store/contact" className="text-[var(--store-muted)] transition hover:text-[var(--store-text)]">
                {t("store.nav.contact")}
              </Link>
            </li>
            {settings.contact.phone ? (
              <li>
                <a
                  href={`tel:${settings.contact.phone}`}
                  className="text-[var(--store-muted)] transition hover:text-[var(--store-text)]"
                >
                  {settings.contact.phone}
                </a>
              </li>
            ) : null}
            {email ? (
              <li>
                <a
                  href={`mailto:${email}`}
                  className="text-[var(--store-muted)] transition hover:text-[var(--store-text)]"
                >
                  {email}
                </a>
              </li>
            ) : null}
            {pick(settings.contact.address_ar, settings.contact.address_en) ? (
              <li className="text-[var(--store-muted)]">
                {pick(settings.contact.address_ar, settings.contact.address_en)}
              </li>
            ) : null}
            {mapLink ? (
              <li>
                <a
                  href={mapLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--store-muted)] underline underline-offset-4 transition hover:text-[var(--store-text)]"
                >
                  {t("store.contact.openMap")}
                </a>
              </li>
            ) : null}
          </ul>
        </div>

        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[var(--store-muted)]">
            {t("store.footer.delivery")}
          </p>
          <ul className="mt-4 space-y-2.5 text-sm text-[var(--store-muted)]">
            {settings.delivery.enabled ? (
              <li>
                {t("store.footer.deliveryFee", {
                  amount: settings.delivery.fee > 0 ? settings.delivery.fee.toString() : "0",
                })}
              </li>
            ) : null}
            {settings.delivery.pickup_enabled ? <li>{t("store.footer.pickupAvailable")}</li> : null}
            {settings.delivery.cod_enabled ? <li>{t("store.footer.codAvailable")}</li> : null}
            {settings.delivery.instapay_enabled ? <li>{t("store.footer.instapayAvailable")}</li> : null}
          </ul>
          {policies.length > 0 ? (
            <>
              <p className="mt-6 text-[10px] font-black uppercase tracking-[0.22em] text-[var(--store-muted)]">
                {t("store.footer.policies")}
              </p>
              <ul className="mt-4 space-y-2.5 text-sm">
                {policies.map((link) => {
                  const href = configuredHref(link.href)!;
                  return (
                    <li key={link.id}>
                      {href.startsWith("#") ? (
                        <Link
                          to={href.slice(1)}
                          className="text-[var(--store-muted)] transition hover:text-[var(--store-text)]"
                        >
                          {pick(link.label_ar, link.label_en)}
                        </Link>
                      ) : (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--store-muted)] transition hover:text-[var(--store-text)]"
                        >
                          {pick(link.label_ar, link.label_en)}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      <div className="border-t border-[var(--store-hairline)] px-6 py-4 text-center text-[11px] tracking-wide text-[var(--store-muted)]" dir={dir}>
        {copyright || `© ${new Date().getFullYear()} ${storeName} — ${t("store.footer.rights")}`}
      </div>
    </footer>
  );
}
