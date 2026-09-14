/**
 * The storefront shell: announcement bar, header, footer, WhatsApp button.
 *
 * Two jobs besides framing the pages. The first is navigation that works on a
 * phone: the header collapses to a drawer, the search field is one tap away, and
 * the cart count is visible from every screen, because a shopper who cannot see
 * what is in their cart abandons it.
 *
 * The second is that everything here is driven by the settings document — logo,
 * store name, tagline, social links, contact details, opening hours, the
 * announcement bar and the background image. An admin who changes any of it sees
 * the change on the next render, with no code and no rebuild.
 *
 * Social links are opened in a new tab with `noopener`: they leave the shop, and
 * the shop should not hand a third party a reference to the window it came from.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import { useStorefront } from "../../hooks/StorefrontProvider";
import { useStoreCart } from "../../hooks/StoreCartProvider";
import { useStoreAccount } from "../../hooks/StoreAccountProvider";
import { storefrontSurfaceStyle } from "../../services/theme";
import { instapayHref } from "../../services/settingsDefaults";
import { StoreImage } from "./StorePrimitives";

/** `wa.me/<number>?text=…` from whatever the admin typed. */
export function whatsappHref(raw: string, message?: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    return message ? `${value}${value.includes("?") ? "&" : "?"}text=${encodeURIComponent(message)}` : value;
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
        d="M12 8.4A3.6 3.6 0 1 0 12 15.6 3.6 3.6 0 0 0 12 8.4Zm0 5.9a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6Zm4.6-6.1a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0ZM12 5.2c1.9 0 2.1 0 2.9.1.9 0 1.4.2 1.7.3.4.2.7.4 1 .7.3.3.5.6.7 1 .1.3.3.8.3 1.7.1.8.1 1 .1 2.9s0 2.1-.1 2.9c0 .9-.2 1.4-.3 1.7-.2.4-.4.7-.7 1-.3.3-.6.5-1 .7-.3.1-.8.3-1.7.3-.8.1-1 .1-2.9.1s-2.1 0-2.9-.1c-.9 0-1.4-.2-1.7-.3a2.8 2.8 0 0 1-1-.7 2.8 2.8 0 0 1-.7-1c-.1-.3-.3-.8-.3-1.7-.1-.8-.1-1-.1-2.9s0-2.1.1-2.9c0-.9.2-1.4.3-1.7.2-.4.4-.7.7-1 .3-.3.6-.5 1-.7.3-.1.8-.3 1.7-.3.8-.1 1-.1 2.9-.1Zm0-1.3c-1.9 0-2.2 0-3 .1-1 0-1.7.2-2.3.4-.6.3-1.2.6-1.7 1.1A4.7 4.7 0 0 0 3.9 7.2c-.2.6-.4 1.3-.4 2.3-.1.8-.1 1.1-.1 3s0 2.2.1 3c0 1 .2 1.7.4 2.3.3.6.6 1.2 1.1 1.7.5.5 1.1.8 1.7 1.1.6.2 1.3.4 2.3.4.8.1 1.1.1 3 .1s2.2 0 3-.1c1 0 1.7-.2 2.3-.4a4.7 4.7 0 0 0 1.7-1.1c.5-.5.8-1.1 1.1-1.7.2-.6.4-1.3.4-2.3.1-.8.1-1.1.1-3s0-2.2-.1-3c0-1-.2-1.7-.4-2.3a4.7 4.7 0 0 0-1.1-1.7 4.7 4.7 0 0 0-1.7-1.1c-.6-.2-1.3-.4-2.3-.4-.8-.1-1.1-.1-3-.1Z"
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

export function StoreLayout({ children }: { children: ReactNode }) {
  const { t, pick, lang, toggleLang, dir } = useI18n();
  const { settings } = useStorefront();
  const { unitCount } = useStoreCart();
  const { customer } = useStoreAccount();
  const navigate = useNavigate();
  const location = useLocation();

  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.search]);

  const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en) || t("app.name");
  const tagline = pick(settings.contact.tagline_ar, settings.contact.tagline_en);
  const social = settings.social;
  const whatsapp = whatsappHref(social.whatsapp, t("store.contact.whatsappMessage"));
  // Same rule as the WhatsApp number: a configured link is only rendered when
  // it is a safe absolute http(s) URL.
  const instapayLink = instapayHref(social.instapay_link);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const query = search.trim();
    navigate(query ? `/store/products?q=${encodeURIComponent(query)}` : "/store/products");
  };

  const navLinks = [
    { to: "/store", label: t("store.nav.home"), end: true },
    { to: "/store/products", label: t("store.nav.products"), end: false },
    { to: "/store/track", label: t("store.nav.track"), end: false },
    { to: "/store/contact", label: t("store.nav.contact"), end: false },
  ];

  return (
    <div
      className="flex min-h-screen flex-col text-[var(--store-text)]"
      style={{
        ...storefrontSurfaceStyle(settings),
        backgroundImage: settings.images.background_url
          ? `url(${settings.images.background_url})`
          : undefined,
        backgroundAttachment: settings.images.background_url ? "fixed" : undefined,
        backgroundSize: "cover",
      }}
    >
      {settings.announcement.enabled ? (
        <div className="bg-[var(--store-secondary)] px-4 py-2 text-center text-xs font-semibold text-[var(--store-on-secondary)]">
          {settings.announcement.href ? (
            <a
              href={settings.announcement.href}
              className="underline-offset-2 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {pick(settings.announcement.text_ar, settings.announcement.text_en)}
            </a>
          ) : (
            pick(settings.announcement.text_ar, settings.announcement.text_en)
          )}
        </div>
      ) : null}

      <header className="sticky top-0 z-30 border-b border-[var(--store-border)] bg-[var(--store-surface)]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[var(--store-max-width,72rem)] items-center gap-3 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={t("store.nav.menu")}
            aria-expanded={menuOpen}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--store-border)] text-[var(--store-text)] lg:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
              <path
                fill="currentColor"
                d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z"
              />
            </svg>
          </button>

          <Link to="/store" className="flex min-w-0 items-center gap-2.5">
            {settings.images.logo_url ? (
              <StoreImage
                src={settings.images.logo_url}
                alt={storeName}
                ratio=""
                className="h-10 w-10 shrink-0 bg-transparent"
                sizes="40px"
              />
            ) : (
              <span
                className="grid h-10 w-10 shrink-0 place-items-center bg-[var(--store-primary)] text-sm font-black text-[var(--store-on-primary)]"
                style={{ borderRadius: "var(--store-radius)" }}
              >
                {storeName.slice(0, 2).toUpperCase()}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-extrabold leading-tight text-[var(--store-text)]">
                {storeName}
              </span>
              {tagline ? (
                <span className="hidden truncate text-[11px] font-medium text-[var(--store-muted)] sm:block">
                  {tagline}
                </span>
              ) : null}
            </span>
          </Link>

          <form onSubmit={submitSearch} className="ms-auto hidden max-w-md flex-1 md:block">
            <label className="relative block">
              <span className="sr-only">{t("store.search.label")}</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("store.search.placeholder")}
                className="w-full border border-[var(--store-border)] bg-[var(--store-surface-alt)] py-2 text-sm text-[var(--store-text)] outline-none transition focus:border-[var(--store-primary)]"
                style={{ borderRadius: "var(--store-radius-button)", paddingInline: "2.5rem 0.9rem" }}
              />
              <svg
                viewBox="0 0 24 24"
                className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--store-muted)]"
                style={{ insetInlineStart: "0.8rem" }}
                aria-hidden
              >
                <path
                  fill="currentColor"
                  d="M10.5 4a6.5 6.5 0 0 1 5.1 10.5l4.2 4.2-1.4 1.4-4.2-4.2A6.5 6.5 0 1 1 10.5 4Zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z"
                />
              </svg>
            </label>
          </form>

          <div className="ms-auto flex items-center gap-1.5 md:ms-0">
            <button
              type="button"
              onClick={toggleLang}
              className="grid h-9 place-items-center rounded-lg border border-[var(--store-border)] px-2 text-xs font-bold text-[var(--store-text)]"
              aria-label={t("store.nav.changeLanguage")}
            >
              {lang === "en" ? "عربي" : "EN"}
            </button>

            <Link
              to="/store/account"
              className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--store-border)] text-[var(--store-text)]"
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

            <Link
              to="/store/cart"
              className="relative grid h-9 place-items-center rounded-lg bg-[var(--store-primary)] px-3 text-[var(--store-on-primary)]"
              aria-label={t("store.cart.title")}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
                <path
                  fill="currentColor"
                  d="M7 4h-2l-1 2h2l2.6 9.2A2 2 0 0 0 10.5 17h7.1a2 2 0 0 0 1.9-1.4L21 8H8.6L7.9 5.5A1 1 0 0 0 7 4Zm3.6 15a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm7 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z"
                />
              </svg>
              {unitCount > 0 ? (
                <span className="absolute -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-[var(--store-accent)] px-1 text-[10px] font-black text-[var(--store-on-accent)]">
                  {unitCount > 99 ? "99+" : unitCount}
                </span>
              ) : null}
            </Link>
          </div>
        </div>

        <nav className="mx-auto hidden w-full max-w-[var(--store-max-width,72rem)] gap-1 px-4 pb-2 sm:px-6 lg:flex">
          {navLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                cn(
                  "rounded-lg px-3 py-1.5 text-sm font-bold transition",
                  isActive
                    ? "bg-[var(--store-primary-soft)] text-[var(--store-primary)]"
                    : "text-[var(--store-muted)] hover:text-[var(--store-text)]",
                )
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        {menuOpen ? (
          <div className="border-t border-[var(--store-border)] bg-[var(--store-surface)] px-4 py-3 lg:hidden">
            <form onSubmit={submitSearch} className="mb-3 md:hidden">
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("store.search.placeholder")}
                className="w-full border border-[var(--store-border)] bg-[var(--store-surface-alt)] px-3 py-2 text-sm outline-none focus:border-[var(--store-primary)]"
                style={{ borderRadius: "var(--store-radius-button)" }}
              />
            </form>
            <div className="flex flex-col gap-1">
              {navLinks.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.end}
                  className="rounded-lg px-3 py-2 text-sm font-bold text-[var(--store-text)] hover:bg-[var(--store-primary-soft)]"
                >
                  {link.label}
                </NavLink>
              ))}
            </div>
          </div>
        ) : null}
      </header>

      <main className="flex-1">{children}</main>

      <footer className="mt-10 border-t border-[var(--store-border)] bg-[var(--store-surface)]">
        <div className="mx-auto grid w-full max-w-[var(--store-max-width,72rem)] gap-8 px-4 py-10 sm:px-6 md:grid-cols-4">
          <div>
            <p className="text-sm font-extrabold text-[var(--store-text)]">{storeName}</p>
            {tagline ? (
              <p className="mt-1 text-xs leading-relaxed text-[var(--store-muted)]">{tagline}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {social.facebook ? (
                <a
                  href={social.facebook}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Facebook"
                  className="grid h-9 w-9 place-items-center rounded-full border border-[var(--store-border)] text-[var(--store-muted)] transition hover:text-[var(--store-primary)]"
                >
                  <SocialIcon kind="facebook" />
                </a>
              ) : null}
              {social.instagram ? (
                <a
                  href={social.instagram}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                  className="grid h-9 w-9 place-items-center rounded-full border border-[var(--store-border)] text-[var(--store-muted)] transition hover:text-[var(--store-primary)]"
                >
                  <SocialIcon kind="instagram" />
                </a>
              ) : null}
              {social.tiktok ? (
                <a
                  href={social.tiktok}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="TikTok"
                  className="grid h-9 w-9 place-items-center rounded-full border border-[var(--store-border)] text-[var(--store-muted)] transition hover:text-[var(--store-primary)]"
                >
                  <SocialIcon kind="tiktok" />
                </a>
              ) : null}
              {whatsapp ? (
                <a
                  href={whatsapp}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="WhatsApp"
                  className="grid h-9 w-9 place-items-center rounded-full border border-[var(--store-border)] text-[var(--store-muted)] transition hover:text-[var(--store-primary)]"
                >
                  <SocialIcon kind="whatsapp" />
                </a>
              ) : null}
              {instapayLink ? (
                <a
                  href={instapayLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="InstaPay"
                  className="grid h-9 w-9 place-items-center rounded-full border border-[var(--store-border)] text-[var(--store-muted)] transition hover:text-[var(--store-primary)]"
                >
                  <SocialIcon kind="instapay" />
                </a>
              ) : null}
            </div>
          </div>

          <div>
            <p className="text-xs font-black uppercase tracking-widest text-[var(--store-muted)]">
              {t("store.footer.shop")}
            </p>
            <ul className="mt-3 space-y-2 text-sm">
              {navLinks.map((link) => (
                <li key={link.to}>
                  <Link to={link.to} className="text-[var(--store-text)] hover:text-[var(--store-primary)]">
                    {link.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link to="/store/account" className="text-[var(--store-text)] hover:text-[var(--store-primary)]">
                  {t("store.account.title")}
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className="text-xs font-black uppercase tracking-widest text-[var(--store-muted)]">
              {t("store.footer.contact")}
            </p>
            <ul className="mt-3 space-y-2 text-sm text-[var(--store-text)]">
              {settings.contact.phone ? (
                <li>
                  <a href={`tel:${settings.contact.phone}`} className="hover:text-[var(--store-primary)]">
                    {settings.contact.phone}
                  </a>
                </li>
              ) : null}
              {settings.contact.email ? (
                <li>
                  <a href={`mailto:${settings.contact.email}`} className="hover:text-[var(--store-primary)]">
                    {settings.contact.email}
                  </a>
                </li>
              ) : null}
              {pick(settings.contact.address_ar, settings.contact.address_en) ? (
                <li className="text-[var(--store-muted)]">
                  {pick(settings.contact.address_ar, settings.contact.address_en)}
                </li>
              ) : null}
              {pick(settings.contact.hours_ar, settings.contact.hours_en) ? (
                <li className="text-[var(--store-muted)]">
                  {pick(settings.contact.hours_ar, settings.contact.hours_en)}
                </li>
              ) : null}
              {settings.contact.map_url ? (
                <li>
                  <a
                    href={settings.contact.map_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-bold text-[var(--store-primary)]"
                  >
                    {t("store.contact.openMap")}
                  </a>
                </li>
              ) : null}
            </ul>
          </div>

          <div>
            <p className="text-xs font-black uppercase tracking-widest text-[var(--store-muted)]">
              {t("store.footer.delivery")}
            </p>
            <ul className="mt-3 space-y-2 text-sm text-[var(--store-muted)]">
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
              {pick(settings.delivery.note_ar, settings.delivery.note_en) ? (
                <li>{pick(settings.delivery.note_ar, settings.delivery.note_en)}</li>
              ) : null}
            </ul>
          </div>
        </div>

        <div className="border-t border-[var(--store-border)] px-4 py-4 text-center text-xs text-[var(--store-muted)] sm:px-6" dir={dir}>
          {t("store.footer.rights", { name: storeName })}
        </div>
      </footer>

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
