/**
 * SEO and shareability.
 *
 * The app is a hash-routed single-page bundle, which is the honest starting
 * point here: no server renders these pages, so there is nothing to serve a
 * `sitemap.xml` from. What *can* be done without touching routing (which this
 * project explicitly protects) is:
 *
 *   1. per-product SEO fields an admin writes once — `seo_title`,
 *      `seo_description`, `slug` — stored on `product_content`;
 *   2. a document-level `<title>`, meta description, canonical link, Open Graph
 *      and Twitter tags, updated as the customer navigates;
 *   3. `schema.org/Product` JSON-LD, which is what makes a rich snippet and a
 *      price in a search result possible at all;
 *   4. a sitemap and a robots file generated in the browser and offered as a
 *      download, for the admin to upload beside the bundle.
 *
 * Everything below is a pure function returning text, except the `apply*` /
 * `clear*` helpers, which are guarded so the module imports cleanly in tests.
 *
 * A note on honesty: a hash URL is indexable but weakly so, and a client-rendered
 * page cannot promise a crawler the content it sees. These helpers do what is
 * worth doing here — real titles, real descriptions, real structured data, real
 * share cards — and none of it pretends to be server-side rendering.
 */
import type { Product } from "@/modules/products/types";
import type { ProductContent, WebsiteSettings } from "../types";
import { resolveSettings } from "./settingsDefaults";

/**
 * A slug that is safe to store.
 *
 * `product_content.slug` is constrained in the database to lowercase ASCII
 * letters, digits and single dashes — the ordinary shape of a URL segment, and
 * the one a crawler, a share card and a hand-typed link all handle without
 * percent-encoding. An Arabic product name therefore slugs from whatever Latin
 * text it has (a size, a brand, a code) and falls back to the SKU, which is
 * always there and always unique: "gold-pearl-earrings" if it can, and
 * "alyq-1001" rather than an empty string or a percent-encoded wall if it cannot.
 *
 * Matching what a customer *typed* is a different job and stays Arabic-aware:
 * `findCatalogProduct` normalises the key rather than the stored slug, so an
 * Arabic search still finds the product whose slug came from its SKU.
 */
export function slugifyAscii(input: string, fallback = ""): string {
  const ascii = String(input ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, " ") // Arabic and accents become separators
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii) return ascii.length > 80 ? ascii.slice(0, 80).replace(/-+$/, "") : ascii;

  const fromFallback = String(fallback ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return fromFallback;
}

/**
 * `#/store/products/<slug-or-id>` — the path a product is reachable at.
 *
 * The slug is cosmetic and the id is the truth: a product with no slug yet is
 * still reachable, and renaming a product does not break a link someone shared.
 */
export function productPath(
  product: { id: string },
  content?: Pick<ProductContent, "slug"> | null,
): string {
  const slug = content?.slug?.trim();
  return `#/store/products/${encodeURIComponent(slug && slug.length > 0 ? slug : product.id)}`;
}

/** Resolve a hash path against the site's origin, for absolute URLs. */
export function absoluteUrl(baseUrl: string, hashPath: string): string {
  const origin = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!origin) return hashPath;
  return `${origin}/${hashPath.replace(/^\/+/, "")}`;
}

export function escapeXml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Trim a description to the length a search result actually shows. */
export function clipDescription(text: string, max = 158): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:!?-]+$/, "")}…`;
}

/**
 * The meta description for a product.
 *
 * Prefers what the admin wrote, then the product's own description with markdown
 * stripped, then the name. Never empty: a page with no description gets one
 * invented from its body text by the crawler, which is worse than a plain name.
 */
export function descriptionForProduct(input: {
  seoDescription?: string | null;
  productDescription?: string | null;
  fallbackName: string;
}): string {
  const own = String(input.seoDescription ?? "").trim();
  if (own) return clipDescription(own);
  const body = String(input.productDescription ?? "")
    .replace(/[#*_`>~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (body) return clipDescription(body);
  return clipDescription(input.fallbackName);
}

/** `<title>` for a product page: the SEO title if there is one, else the name. */
export function titleForProduct(input: {
  name: string;
  seoTitle?: string | null;
  storeName: string;
}): string {
  const base = String(input.seoTitle ?? "").trim() || String(input.name ?? "").trim();
  const store = String(input.storeName ?? "").trim();
  if (!base) return store || "ALYQ";
  if (!store || base.includes(store)) return base;
  return `${base} | ${store}`;
}

/** Site keywords, as an admin typed them in one comma-separated field. */
export function keywordList(raw: string | null | undefined, limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const keyword of String(raw ?? "").split(/[,،\n]+/)) {
    const clean = keyword.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Suggest a slug for a product the admin has not written one for.
 *
 * Built by `slugifyAscii`, so what is suggested is always what can be stored:
 * the column has an ASCII shape constraint, and a suggestion the database would
 * reject is worse than no suggestion at all. An Arabic-only product name
 * therefore suggests its SKU, and the admin can type a better one.
 */
export function suggestedSlug(product: {
  name_ar: string | null;
  name_en: string | null;
  sku: string;
}): string {
  return (
    slugifyAscii(product.name_en || product.name_ar || "", product.sku) ||
    slugifyAscii(product.sku)
  );
}

// ── structured data ─────────────────────────────────────────────────────────

export interface ProductSchemaInput {
  product: Product;
  content?: ProductContent | null;
  categoryName?: string | null;
  /** The price the storefront is actually charging — campaign price included. */
  price: number;
  baseUrl: string;
  /** The store name, for the offer's seller. */
  storeName: string;
  pick: (arabic: string | null, english: string | null) => string;
}

/**
 * `schema.org/Product` JSON-LD.
 *
 * Offered only for a product that is on the shelf and buyable: publishing an
 * offer for something a customer cannot buy is how a shop earns a rich-result
 * penalty, and an out-of-stock offer says so explicitly rather than being
 * dropped, so the price and availability in a search result stay true.
 */
export function productJsonLd(input: ProductSchemaInput): Record<string, unknown> | null {
  const { product } = input;
  if (!product.active || !product.show_on_website) return null;
  const name = input.pick(product.name_ar, product.name_en).trim();
  if (!name) return null;

  const inStock = !product.stock_tracking_enabled || product.stock_quantity > 0;
  const brand = input.pick(input.content?.brand_ar ?? null, input.content?.brand_en ?? null).trim();
  const url = absoluteUrl(input.baseUrl, productPath(product, input.content));

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name,
    sku: product.sku,
    url,
    description: descriptionForProduct({
      seoDescription: input.content?.seo_description,
      productDescription: input.pick(product.description_ar, product.description_en),
      fallbackName: name,
    }),
  };
  if (product.barcode) schema.gtin = product.barcode;
  if (product.image_url) schema.image = product.image_url;
  else if (product.images.length > 0) schema.image = product.images[0];
  if (brand) schema.brand = { "@type": "Brand", name: brand };
  if (input.categoryName) schema.category = input.categoryName;

  schema.offers = {
    "@type": "Offer",
    price: Math.max(input.price, 0).toFixed(2),
    priceCurrency: "EGP",
    availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    url,
    seller: input.storeName ? { "@type": "Organization", name: input.storeName } : undefined,
  };
  return schema;
}

/** `schema.org/Store` JSON-LD for the homepage — what makes the shop itself findable. */
export function storeJsonLd(settings: WebsiteSettings, baseUrl: string): Record<string, unknown> {
  const name =
    settings.contact.store_name_en.trim() || settings.contact.store_name_ar.trim() || "ALYQ";
  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Store",
    name,
    url: absoluteUrl(baseUrl, "#/store"),
    description: clipDescription(
      settings.seo.meta_description ||
        settings.contact.tagline_en ||
        settings.contact.tagline_ar ||
        name,
    ),
    currenciesAccepted: settings.currency,
  };
  if (settings.images.logo_url) schema.logo = settings.images.logo_url;
  if (settings.contact.phone) schema.telephone = settings.contact.phone;
  if (settings.contact.email) schema.email = settings.contact.email;
  const address = settings.contact.address_en.trim() || settings.contact.address_ar.trim();
  if (address) schema.address = { "@type": "PostalAddress", streetAddress: address };
  if (settings.contact.map_url) schema.hasMap = settings.contact.map_url;
  const sameAs = [
    settings.social.facebook,
    settings.social.instagram,
    settings.social.tiktok,
  ].filter((link) => link.trim().length > 0);
  if (sameAs.length > 0) schema.sameAs = sameAs;
  return schema;
}

// ── sitemap + robots ────────────────────────────────────────────────────────

export interface SitemapPage {
  path: string;
  lastModified?: string | null;
  changeFrequency?:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority?: number;
}

export function buildSitemapXml(input: {
  baseUrl: string;
  pages: readonly SitemapPage[];
}): string {
  const urls = input.pages
    .filter((page) => page.path.trim().length > 0)
    .map((page) => {
      const parts = [`    <loc>${escapeXml(absoluteUrl(input.baseUrl, page.path))}</loc>`];
      if (page.lastModified) {
        const date = new Date(page.lastModified);
        if (!Number.isNaN(date.getTime())) {
          parts.push(`    <lastmod>${date.toISOString().slice(0, 10)}</lastmod>`);
        }
      }
      parts.push(`    <changefreq>${page.changeFrequency ?? "weekly"}</changefreq>`);
      parts.push(`    <priority>${(page.priority ?? 0.5).toFixed(1)}</priority>`);
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * robots.txt.
 *
 * The back office is disallowed whatever the storefront says: a crawler that
 * finds `/pos` finds a login form, and there is nothing behind it worth indexing.
 */
export function buildRobotsTxt(baseUrl: string): string {
  const origin = String(baseUrl || "").trim().replace(/\/+$/, "");
  const lines = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /#/pos",
    "Disallow: /#/settings",
    "Disallow: /#/reports",
    "Disallow: /#/inventory",
    "Disallow: /#/customers",
  ];
  if (origin) lines.push("", `Sitemap: ${origin}/sitemap.xml`);
  return `${lines.join("\n")}\n`;
}

/** The pages a storefront sitemap should contain. */
export function storefrontSitemapPages(input: {
  settings: WebsiteSettings | null;
  products: readonly Product[];
  contents: readonly Pick<ProductContent, "product_id" | "slug">[];
}): SitemapPage[] {
  // resolveSettings is called so a null document still yields a usable sitemap.
  void resolveSettings(input.settings);
  const contentByProduct = new Map(input.contents.map((content) => [content.product_id, content]));
  const pages: SitemapPage[] = [
    { path: "#/store", changeFrequency: "daily", priority: 1 },
    { path: "#/store/products", changeFrequency: "daily", priority: 0.9 },
    { path: "#/store/cart", changeFrequency: "weekly", priority: 0.4 },
    { path: "#/store/track", changeFrequency: "weekly", priority: 0.4 },
  ];
  for (const product of input.products) {
    // Off the website or inactive means out of the sitemap: listing a product the
    // storefront will not show sends a crawler to a page with nothing on it.
    if (!product.active || !product.show_on_website) continue;
    pages.push({
      path: productPath(product, contentByProduct.get(product.id)),
      lastModified: product.updated_at,
      changeFrequency: "weekly",
      priority: 0.8,
    });
  }
  return pages;
}

// ── document head ───────────────────────────────────────────────────────────

export interface DocumentMeta {
  title: string;
  description: string;
  canonical?: string | null;
  keywords?: string[];
  noIndex?: boolean;
  ogImage?: string | null;
  ogType?: "website" | "product";
  locale?: string;
  siteName?: string;
}

function setMeta(selector: string, attributes: Record<string, string>): void {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    document.head.appendChild(element);
  }
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
}

function setLink(rel: string, href: string | null): void {
  const element = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!href) {
    element?.remove();
    return;
  }
  const link = element ?? document.createElement("link");
  if (!element) {
    link.rel = rel;
    document.head.appendChild(link);
  }
  link.href = href;
}

/**
 * Write one page's metadata into `<head>`.
 *
 * Called on every storefront navigation, and cleared when the user returns to
 * the POS: a till screen titled "Ethiopian Beans | My Shop" would be a small
 * thing to notice and a large thing to explain.
 */
export function applyDocumentMeta(meta: DocumentMeta): void {
  if (typeof document === "undefined") return;
  document.title = meta.title;
  setMeta('meta[name="description"]', { name: "description", content: meta.description });
  setMeta('meta[name="keywords"]', {
    name: "keywords",
    content: (meta.keywords ?? []).join(", "),
  });
  setMeta('meta[name="robots"]', {
    name: "robots",
    content: meta.noIndex ? "noindex, nofollow" : "index, follow",
  });

  setMeta('meta[property="og:title"]', { property: "og:title", content: meta.title });
  setMeta('meta[property="og:description"]', {
    property: "og:description",
    content: meta.description,
  });
  setMeta('meta[property="og:type"]', { property: "og:type", content: meta.ogType ?? "website" });
  if (meta.siteName) {
    setMeta('meta[property="og:site_name"]', {
      property: "og:site_name",
      content: meta.siteName,
    });
  }
  if (meta.locale) {
    setMeta('meta[property="og:locale"]', { property: "og:locale", content: meta.locale });
  }
  if (meta.ogImage) {
    setMeta('meta[property="og:image"]', { property: "og:image", content: meta.ogImage });
    setMeta('meta[name="twitter:card"]', {
      name: "twitter:card",
      content: "summary_large_image",
    });
    setMeta('meta[name="twitter:image"]', { name: "twitter:image", content: meta.ogImage });
  } else {
    setMeta('meta[name="twitter:card"]', { name: "twitter:card", content: "summary" });
  }
  setMeta('meta[name="twitter:title"]', { name: "twitter:title", content: meta.title });
  setMeta('meta[name="twitter:description"]', {
    name: "twitter:description",
    content: meta.description,
  });

  setLink("canonical", meta.canonical ?? null);
}

const JSON_LD_ID = "alyq-store-jsonld";

/** Replace the page's JSON-LD, or remove it when there is none. */
export function applyJsonLd(schema: Record<string, unknown> | null): void {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(JSON_LD_ID);
  if (!schema) {
    existing?.remove();
    return;
  }
  const script = existing ?? document.createElement("script");
  script.id = JSON_LD_ID;
  script.setAttribute("type", "application/ld+json");
  script.textContent = JSON.stringify(schema);
  if (!existing) document.head.appendChild(script);
}

/** Remove everything the storefront added to `<head>`. */
export function clearDocumentMeta(defaultTitle = "ALYQ Cloud POS"): void {
  if (typeof document === "undefined") return;
  document.title = defaultTitle;
  applyJsonLd(null);
  setLink("canonical", null);
  for (const selector of [
    'meta[property="og:title"]',
    'meta[property="og:description"]',
    'meta[property="og:image"]',
    'meta[property="og:type"]',
    'meta[property="og:site_name"]',
    'meta[property="og:locale"]',
    'meta[name="twitter:card"]',
    'meta[name="twitter:title"]',
    'meta[name="twitter:description"]',
    'meta[name="twitter:image"]',
    'meta[name="keywords"]',
    'meta[name="robots"]',
  ]) {
    document.head.querySelector(selector)?.remove();
  }
}

/**
 * Offer a generated file for download.
 *
 * There is no backend to write `sitemap.xml` to, so the admin gets the file and
 * puts it wherever the bundle is served from. That keeps the feature real
 * instead of a button that silently does nothing.
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mime = "text/plain",
): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers; a tick is
  // enough for the click to have been handed off.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
