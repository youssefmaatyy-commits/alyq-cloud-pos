import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { useStoreCart } from "../hooks/StoreCartProvider";
import { useStoreAccount } from "../hooks/StoreAccountProvider";
import { announcementIntervalMs, resolvedAnnouncementMessages } from "../services/settingsDefaults";
import { isCampaignLive, isPromotionLive } from "../services/pricing";
import { adaptV2Appearance, v2Href } from "./appearance";
import { V2ActionLink, V2Icon as Icon } from "./Primitives";
import { resolvedV2SocialChannels, V2SocialIcons } from "./SocialChannels";
import { SocialIcon } from "../components/storefront/SocialIcon";
import "./storefront-v2.css";

export function StorefrontV2Shell({ children }: { children: ReactNode }) {
  const { t, pick, dir, lang, toggleLang } = useI18n();
  const { settings, categoriesFacet, categoryContents, sections, campaigns, promotions } = useStorefront();
  const { unitCount, addPulse } = useStoreCart();
  const { customer } = useStoreAccount();
  const location = useLocation();
  const navigate = useNavigate();
  const appearance = useMemo(() => adaptV2Appearance(settings), [settings]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [messageIndex, setMessageIndex] = useState(0);
  // Shared add-to-cart feedback: one global toast and a one-time bag-icon
  // pulse, both driven by the cart provider's own success signal so every
  // add entry point (quick add, variant picker, PDP) gets the same reaction
  // without each of them rendering its own copy of this UI.
  const [bagPulse, setBagPulse] = useState(false);
  const [addedToastVisible, setAddedToastVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));
  const drawerRef = useRef<HTMLElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const messages = useMemo(() => resolvedAnnouncementMessages(settings), [settings]);
  const categories = categoriesFacet.slice(0, 12);
  const hasOffers = campaigns.some((campaign) => isCampaignLive(campaign)) || promotions.some((promotion) => isPromotionLive(promotion));
  const brandNameAr = settings.brand.display_name_ar || settings.contact.store_name_ar;
  const brandNameEn = settings.brand.display_name_en || settings.contact.store_name_en;
  const storeName = pick(brandNameAr, brandNameEn);
  // The header wordmark is the shop's own configured name in both languages
  // (Website Settings → Brand, falling back to the store name already used
  // for the aria-label), never a hardcoded "ALYQ" string — a renamed shop
  // gets a renamed header for free. The current UI language leads; the other
  // script follows in a muted accent tone, and `dir` (not `dir="auto"`,
  // which gets confused once both scripts share one line) keeps the pair in
  // the right reading order for RTL.
  const wordmarkPrimary = lang === "ar" ? { text: brandNameAr, code: "ar" } : { text: brandNameEn, code: "en" };
  const wordmarkSecondary = lang === "ar" ? { text: brandNameEn, code: "en" } : { text: brandNameAr, code: "ar" };
  const hasBilingualWordmark = Boolean(wordmarkPrimary.text) && Boolean(wordmarkSecondary.text)
    && wordmarkPrimary.text !== wordmarkSecondary.text;
  const wordmark = hasBilingualWordmark ? (
    <span className="v2-wordmark" dir={dir}>
      <span className="v2-wordmark-primary" lang={wordmarkPrimary.code}>{wordmarkPrimary.text}</span>
      <span className="v2-wordmark-divider" aria-hidden="true">|</span>
      <span className="v2-wordmark-secondary" lang={wordmarkSecondary.code}>{wordmarkSecondary.text}</span>
    </span>
  ) : (
    // A single configured name (no distinct second-language name to pair
    // it with) still gets the same gold header treatment as the bilingual
    // lockup above, not the header's plain text colour.
    <span className="v2-wordmark-primary" dir="auto">{storeName}</span>
  );
  const social = resolvedV2SocialChannels(settings, lang);
  const whatsapp = social.find((channel) => channel.platform === "whatsapp");
  const catContent = new Map(categoryContents.map((row) => [row.category_id, row]));

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    // `addPulse` starts at 0 and only increments on a real successful add, so
    // this never fires on mount — only on an actual add-to-cart. A second add
    // while the toast/pulse is still showing simply restarts both timers
    // (the cleanup below clears the previous ones), which keeps the toast on
    // screen rather than letting two in a row make it flicker.
    if (addPulse === 0) return;
    setBagPulse(true);
    setAddedToastVisible(true);
    const pulseTimer = window.setTimeout(() => setBagPulse(false), 650);
    const toastTimer = window.setTimeout(() => setAddedToastVisible(false), 2600);
    return () => { window.clearTimeout(pulseTimer); window.clearTimeout(toastTimer); };
  }, [addPulse]);

  useEffect(() => {
    if (reducedMotion) return;
    if (!settings.announcement.enabled || messages.length < 2 || settings.announcement.mode !== "rotate") return;
    const interval = window.setInterval(() => setMessageIndex((value) => (value + 1) % messages.length), announcementIntervalMs(settings));
    return () => window.clearInterval(interval);
  }, [messages.length, settings, reducedMotion]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const trigger = menuTrigger.current;
    document.body.style.overflow = "hidden";
    drawerRef.current?.querySelector<HTMLElement>('[data-testid="v2-menu-close"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
      }
      if (event.key !== "Tab") return;
      const focusable = [...(drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),[tabindex="0"]',
      ) ?? [])].filter((node) => node.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      else trigger?.focus();
    };
  }, [menuOpen]);

  useEffect(() => {
    // Back/forward navigation while the drawer is open must not leave a body lock.
    setMenuOpen(false);
    setSearchOpen(false);
  }, [location.pathname]);

  const closeAndNavigate = (path: string) => { setMenuOpen(false); navigate(path); };
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = search.trim();
    setSearchOpen(false);
    navigate(`/store/products${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  };
  const message = messages[(reducedMotion ? 0 : messageIndex) % (messages.length || 1)];
  const scroll = settings.announcement.mode === "scroll";
  // Clamped shared cadence controls scroll speed too; long copy gets time to
  // pass without a new V2-only timing setting.
  const tickerDuration = `${Math.max(12, Math.min(180, (announcementIntervalMs(settings) / 1000) * messages.length))}s`;
  const announcementContent = (item: (typeof messages)[number], duplicate = false) => {
    const content = `${pick(item.text_ar, item.text_en)}${item.cta_ar || item.cta_en ? ` · ${pick(item.cta_ar, item.cta_en)}` : ""}`;
    const href = item.href ?? settings.announcement.href;
    return href && !duplicate && v2Href(href)
      ? <V2ActionLink href={href} className="v2-announcement-link">{content}</V2ActionLink>
      : <span>{content}</span>;
  };
  const newsletterEmail = settings.contact.email.trim();

  return (
    <div className="store-v2" dir={dir} style={appearance.variables} data-testid="store-v2">
      <a href="#v2-main" className="v2-skip" onClick={(event) => {
        // HashRouter owns the fragment. Native #v2-main navigation would be
        // mistaken for a route and send the shopper to the login fallback.
        event.preventDefault();
        document.getElementById("v2-main")?.focus();
      }}>{t("store.v2.skip")}</a>
      {settings.announcement.enabled && message ? (
        <div className={`v2-announcement${scroll ? " v2-announcement-scroll" : ""}`}
          role="region" aria-label={t("store.announcements.label")}
          style={scroll ? { "--v2-ticker-duration": tickerDuration } as CSSProperties : undefined}>
          {scroll ? <div className="v2-announcement-window">
            <div className="v2-announcement-track" data-testid="v2-announcement-track">
              <div className="v2-announcement-copy">
                {messages.map((item) => <span className="v2-announcement-item" key={item.id}>{announcementContent(item)}</span>)}
              </div>
              <div className="v2-announcement-copy" aria-hidden="true">
                {messages.map((item) => <span className="v2-announcement-item" key={item.id}>{announcementContent(item, true)}</span>)}
              </div>
            </div>
          </div> : <span aria-live={settings.announcement.mode === "rotate" && !reducedMotion ? "polite" : "off"}>
            {announcementContent(message)}
          </span>}
        </div>
      ) : null}
      <header className={`v2-header ${appearance.stickyHeader ? "v2-header-sticky" : ""}`}>
        <div className="v2-header-inner">
          <div className="v2-header-start">
            <button ref={menuTrigger} type="button" className="v2-icon-button v2-mobile-only"
              data-testid="v2-menu-open" aria-label={t("store.nav.menu")} aria-expanded={menuOpen}
              aria-controls="v2-drawer" onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>
            {appearance.showSearch ? (
              <button type="button" className="v2-icon-button" aria-label={t("store.search.label")}
                aria-expanded={searchOpen} onClick={() => setSearchOpen((value) => !value)}><Icon name="search" /></button>
            ) : null}
          </div>
          {/* A text wordmark is the safe fallback. When the merchant configured
             a real V2 logo, expose a responsive picture: the saved mobile
             asset is part of the public shell after a fresh boot, not only the
             Studio preview. */}
          <Link to="/store" className="v2-logo" aria-label={storeName}>
            {appearance.headerLogoUrl || appearance.mobileLogoUrl ? (
              <picture>
                <source media="(max-width: 767px)" srcSet={appearance.mobileLogoUrl ?? appearance.headerLogoUrl ?? ""} />
                <img src={appearance.headerLogoUrl ?? appearance.mobileLogoUrl ?? ""} alt={storeName} />
              </picture>
            ) : wordmark}
          </Link>
          <div className="v2-header-end">
            {appearance.showLanguage ? <button type="button" className="v2-language-button v2-desktop-only" onClick={toggleLang}
              aria-label={t("store.nav.changeLanguage")}>{lang === "ar" ? "EN" : "عربي"}</button> : null}
            {appearance.showAccount ? <Link to="/store/account" className="v2-icon-button" aria-label={t("store.account.title")}
              title={customer ? customer.name : t("store.account.signIn")}><Icon name="user" /></Link> : null}
            {appearance.showCart ? <Link to="/store/cart" className="v2-icon-button v2-bag-button"
              data-pulse={bagPulse || undefined} aria-label={`${t("store.v2.bag")} (${unitCount})`}>
              <Icon name="bag" /><span className="v2-bag-count" aria-hidden>{unitCount}</span>
            </Link> : null}
          </div>
        </div>
        <nav className="v2-desktop-nav" aria-label={t("store.nav.menu")}>
          <Link to="/store">{t("store.nav.home")}</Link>
          <Link to="/store/products">{t("store.nav.products")}</Link>
          {categories.slice(0, 3).map((category) => (
            <Link key={category.id} to={`/store/products?category=${encodeURIComponent(category.id)}`}>
              {pick(catContent.get(category.id)?.title_ar || category.name_ar, catContent.get(category.id)?.title_en || category.name_en)}
            </Link>
          ))}
          {hasOffers ? <Link to="/store/products?offer=1">{t("store.section.onSale")}</Link> : null}
          <Link to="/store/about">{t("store.nav.about")}</Link>
        </nav>
        {appearance.showSearch && searchOpen ? <form className="v2-search-row" onSubmit={submitSearch} role="search">
          <input ref={searchRef} type="search" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder={t("store.search.placeholder")} aria-label={t("store.search.label")} />
          <button type="submit" className="v2-search-submit" aria-label={t("store.v2.searchGo")}><Icon name="arrow" /></button>
        </form> : null}
      </header>

      <div className="v2-drawer-layer" data-open={menuOpen} inert={!menuOpen} aria-hidden={!menuOpen}>
        <button type="button" className="v2-drawer-backdrop" aria-label={t("common.close")}
          tabIndex={menuOpen ? 0 : -1} onClick={() => setMenuOpen(false)} />
        <aside id="v2-drawer" ref={drawerRef} role="dialog" aria-modal={menuOpen ? true : undefined}
          aria-label={t("store.nav.menu")} className="v2-drawer">
          <div className="v2-drawer-top"><span className="v2-eyebrow">{storeName}</span>
            <button type="button" data-testid="v2-menu-close" className="v2-icon-button" aria-label={t("common.close")}
              onClick={() => setMenuOpen(false)}><Icon name="close" /></button></div>
          <div className="v2-drawer-scroll">
            <p className="v2-drawer-label">{t("store.footer.shop")}</p>
            <button type="button" onClick={() => closeAndNavigate("/store")}>{t("store.nav.home")}</button>
            <button type="button" onClick={() => closeAndNavigate("/store/products")}>{t("store.nav.products")}</button>
            {sections.some((section) => section.key === "newArrivals") ? (
              <button type="button" onClick={() => closeAndNavigate("/store/products?sort=newest")}>{t("store.nav.new")}</button>
            ) : null}
            {hasOffers ? <button type="button" onClick={() => closeAndNavigate("/store/products?offer=1")}>{t("store.section.onSale")}</button> : null}
            <p className="v2-drawer-label">{t("store.nav.categories")}</p>
            {categories.map((category) => (
              <button type="button" key={category.id} onClick={() => closeAndNavigate(`/store/products?category=${encodeURIComponent(category.id)}`)}>
                {pick(catContent.get(category.id)?.title_ar || category.name_ar, catContent.get(category.id)?.title_en || category.name_en)}
              </button>
            ))}
            <p className="v2-drawer-label">{t("store.footer.info")}</p>
            <button type="button" onClick={() => closeAndNavigate("/store/about")}>{t("store.nav.about")}</button>
            <button type="button" onClick={() => closeAndNavigate("/store/contact")}>{t("store.nav.contact")}</button>
            {/* Hiding a header icon never makes the existing cart/account routes undiscoverable. */}
            <button type="button" onClick={() => closeAndNavigate("/store/cart")}>{t("store.v2.bag")} ({unitCount})</button>
            <button type="button" onClick={() => closeAndNavigate("/store/account")}>{t("store.account.title")}</button>
          </div>
          <div className="v2-drawer-foot">{appearance.showLanguage ? <button type="button" onClick={toggleLang}
            aria-label={t("store.nav.changeLanguage")}>{lang === "ar" ? "English" : "العربية"}</button> : null}
            <span>{t("store.v2.collection")}</span></div>
        </aside>
      </div>

      <main id="v2-main" className="v2-main" tabIndex={-1}>{children}</main>
      <footer className="v2-footer">
        {settings.footer.newsletter_enabled && newsletterEmail.includes("@") ? (
          <div className="v2-footer-newsletter">
            <div><p className="v2-eyebrow">{t("store.footer.newsletterTitle")}</p>
              {settings.footer.newsletter_note_ar || settings.footer.newsletter_note_en ? (
                <p>{pick(settings.footer.newsletter_note_ar, settings.footer.newsletter_note_en)}</p>
              ) : null}
              <small>{t("store.v2.newsletterNote")}</small></div>
            <a href={`mailto:${encodeURIComponent(newsletterEmail)}?subject=${encodeURIComponent("ALYQ news")}`}
              className="v2-footer-mail">{t("store.v2.newsletterAction")} <Icon name="arrow" /></a>
          </div>
        ) : null}
        <div className="v2-footer-inner">
          <div className="v2-footer-brand">
            <p className="v2-footer-wordmark" dir="auto">{storeName}</p>
            <p>{pick(settings.footer.description_ar || settings.contact.tagline_ar,
              settings.footer.description_en || settings.contact.tagline_en)}</p>
            {settings.footer.show_social ? <V2SocialIcons channels={social} /> : null}
          </div>
          <nav aria-label={t("store.footer.shop")}><h2>{t("store.footer.shop")}</h2>
            <Link to="/store/products">{t("store.nav.products")}</Link>
            <Link to="/store/products?sort=newest">{t("store.nav.new")}</Link>
            {hasOffers ? <Link to="/store/products?offer=1">{t("store.section.onSale")}</Link> : null}
          </nav>
          <nav aria-label={t("store.footer.info")}><h2>{t("store.footer.info")}</h2>
            <Link to="/store/about">{t("store.nav.about")}</Link>
            <Link to="/store/contact">{t("store.nav.contact")}</Link>
            <Link to="/store/track">{t("store.track.title")}</Link>
            {settings.footer.policy_links.filter((item) => item.enabled).map((item) => (
              <V2ActionLink key={item.id} href={item.href}>{pick(item.label_ar, item.label_en)}</V2ActionLink>
            ))}
          </nav>
          <div className="v2-footer-contact"><h2>{t("store.footer.contact")}</h2>
            {settings.contact.email ? <a href={`mailto:${encodeURIComponent(settings.contact.email)}`}>{settings.contact.email}</a> : null}
            {settings.contact.phone ? <a href={`tel:${settings.contact.phone.replace(/[^+0-9]/g, "")}`}>{settings.contact.phone}</a> : null}
            {whatsapp ? <a className="v2-footer-contact-action" data-testid="v2-whatsapp-contact"
              href={whatsapp.href} target="_blank" rel="noopener noreferrer"
              aria-label={`${t("store.v2.whatsappContact")} ${t("common.opensInNewTab")}`}>
              <SocialIcon kind="whatsapp" />{t("store.v2.whatsappContact")}
            </a> : null}
            <p>{pick(settings.contact.address_ar, settings.contact.address_en)}</p>
          </div>
        </div>
        <div className="v2-footer-bottom"><span>{pick(settings.footer.copyright_ar, settings.footer.copyright_en) || `© ${new Date().getFullYear()} ${storeName}`}</span>
          {appearance.showLanguage ? <button type="button" onClick={toggleLang}
            aria-label={t("store.nav.changeLanguage")}>{lang === "ar" ? "English" : "العربية"}</button> : null}
        </div>
      </footer>
      {/* One shared confirmation for every add-to-cart action on the site.
          `key={addPulse}` forces a fresh text node on each add so a screen
          reader announces repeat identical messages too, not only the first. */}
      <div className="v2-added-toast" data-visible={addedToastVisible || undefined} aria-hidden={!addedToastVisible}>
        <span className="v2-added-toast-bubble" role="status" aria-live="polite" key={addPulse}>
          <Icon name="check" />{t("store.v2.added")}
        </span>
      </div>
    </div>
  );
}
