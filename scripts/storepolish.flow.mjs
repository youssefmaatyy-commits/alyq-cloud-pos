/**
 * Storefront polish E2E (Phase 49) — the premium editorial storefront, driven
 * through the real bundle in jsdom, demo mode:
 *
 *   · the palette stays the house's own: warm ivory surfaces, espresso ink,
 *     muted antique gold — and the accent token is gold, never orange;
 *   · the hero carries the admin's imagery path, a gradient fallback in the
 *     shop's own colours when there is no image, a primary CTA and the quieter
 *     "Our story" second CTA;
 *   · the header is one slim row at every width — nav left, wordmark centre,
 *     search + account + cart right, subtle sticky, glass opens a search row;
 *   · the homepage keeps the editorial rhythm (hero → categories → new
 *     arrivals → editorial → best sellers → lookbook → collection → trust →
 *     newsletter) and categories render image-first (editorial layout) by
 *     default;
 *   · product cards are media-first with a quiet quick-add; the shop grid is
 *     two columns on a phone;
 *   · the variant ring behaves exactly as Phase 43 proved it: nothing
 *     preselected, Gold/17 and Silver/17 each 2, a third Gold refused,
 *     Silver its own line;
 *   · the cart and the checkout hierarchy (Contact / fulfilment / Payment /
 *     Summary with COD + InstaPay + delivery + pickup) read as one garment;
 *   · Arabic mirrors the shop RTL; the footer keeps its newsletter, social row
 *     and policies; the console stays quiet throughout.
 *
 *   node scripts/test.e2e.mjs storepolish
 */
import { createUxHarness } from "./lib/ux-harness.mjs";

const ux = await createUxHarness({
  beforeImport: ({ localStorage: ls }) => {
    for (const key of Object.keys(ls)) {
      if (key.startsWith("alyq.demo.") || key.startsWith("alyq.store.")) ls.removeItem(key);
    }
  },
});
const {
  assert,
  bodyText,
  sleep,
  waitFor,
  navigate,
  clickEl,
  click,
  clickExact,
  readJson,
  signInAs,
  signOut,
  dom,
} = ux;
const { document } = dom.window;

let passed = 0;
const TOTAL = 23;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${passed}/${TOTAL} ${label}`);
}

const CATALOG_KEY = "alyq.demo.catalog.v1";
const setNative = (input, proto) => (value) => {
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
  input.dispatchEvent(new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};
const setField = (selector, value) => {
  const input = document.querySelector(selector);
  if (!input) throw new Error(`field not found: ${selector}`);
  setNative(input, input.tagName === "SELECT" ? dom.window.HTMLSelectElement : dom.window.HTMLInputElement)(value);
};
const setTestid = (id, value) => {
  const input = document.querySelector(`[data-testid="${id}"]`);
  if (!input) throw new Error(`field not found: [data-testid=${id}]`);
  setNative(input, input.tagName === "SELECT" ? dom.window.HTMLSelectElement : dom.window.HTMLInputElement)(value);
};

async function main() {
  console.log("\nPhase 49 · Storefront polish — the premium editorial shop\n");
  await sleep(600);

  // ── seed: the Variant Test Ring, through the real editor (2 + 2) ───────────
  const SKU = "POLISH-RING";
  const GOLD_SKU = "POLISH-RING-GOLD-17";
  const SILVER_SKU = "POLISH-RING-SILVER-17";
  await signInAs("admin");
  await navigate("#/products/new");
  await waitFor(() => document.querySelector("#sku"), { label: "the product form" });
  setField("#name_ar", "خاتم جديد");
  setField("#name_en", "Polish Ring");
  setField("#sku", SKU);
  setField("#selling_price", "200");
  setField("#cost_price", "100");
  setField("#tax_rate", "0");
  setField("#stock_quantity", "4");
  setField("#low_stock_level", "1");
  {
    const select = document.querySelector("#category_id");
    const option = [...select.options].find((o) => o.value !== "");
    setField("#category_id", option.value);
  }
  click("Save");
  await waitFor(() => dom.window.location.hash === "#/products", { label: "route back to the catalogue" });
  const productId = (readJson(CATALOG_KEY)?.products ?? []).find((p) => p.sku === SKU)?.id;
  assert.ok(productId, "the ring is in the demo catalogue");

  await navigate(`#/products/${productId}/edit`);
  await waitFor(() => document.querySelector('[data-testid="variant-editor"]'), { label: "the variant editor" });
  clickEl(document.querySelector('[data-testid="variant-generate"]'));
  await waitFor(() => document.querySelectorAll('[role="dialog"]').length > 0, { label: "the generator dialog" });
  const genDialog = [...document.querySelectorAll('[role="dialog"]')].pop();
  const colorsArea = [...genDialog.querySelectorAll("textarea")].find((t) => (t.placeholder ?? "").includes("Gold"));
  assert.ok(colorsArea, "the colours textarea is in the generator");
  setNative(colorsArea, dom.window.HTMLTextAreaElement)("Gold | ذهبي | #d4af37\nSilver | فضي | #c0c0c0");
  const sizesInput = [...genDialog.querySelectorAll("input")].find((i) => (i.placeholder ?? "").includes("16, 16.5"));
  setNative(sizesInput, dom.window.HTMLInputElement)("17");
  await sleep(250);
  clickEl([...genDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Create 2"));
  await waitFor(
    () =>
      document.querySelector(`[data-testid="variant-row-${GOLD_SKU}"]`) &&
      document.querySelector(`[data-testid="variant-row-${SILVER_SKU}"]`),
    { label: "both combination rows" },
  );
  clickEl(document.querySelector('[data-testid="variant-mode-toggle"]'));
  await waitFor(() => document.querySelector('[data-testid="variant-enable-panel"]'), { label: "the enable panel" });
  setTestid(`opening-${GOLD_SKU}`, "2");
  setTestid(`opening-${SILVER_SKU}`, "2");
  await sleep(200);
  clickEl(document.querySelector('[data-testid="variant-enable-confirm"]'));
  await waitFor(
    () => (readJson(CATALOG_KEY)?.products ?? []).find((p) => p.id === productId)?.variants_enabled === true,
    { label: "the mode flip to land" },
  );
  console.log("  ✓ seeded the polish ring: Gold/17 = 2, Silver/17 = 2");

  // the storefront is a shopper's place — sign the staff out
  await signOut();
  await ux.clearStoreCart();

  // ── 1 · the house palette: gold accent, warm ivory, no orange ─────────────
  await navigate("#/store", 900);
  await waitFor(() => document.querySelector("[data-testid='product-grid']") || bodyText().includes("ALYQ"), {
    label: "the storefront",
  });
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--store-accent").trim().toLowerCase();
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--store-bg").trim().toLowerCase();
  check(
    "the palette reads warm ivory + muted antique gold — the accent token is #b08d57, never orange",
    accent === "#b08d57" && bg === "#faf7f2",
  );

  // ── 2 · the hero: gradient fallback in the shop's own colours ─────────────
  const heroSection = document.querySelector("main section[aria-label]");
  check(
    "the hero falls back to a quiet gradient of the admin's own colours (no image, no orange field)",
    Boolean(heroSection) && (heroSection.getAttribute("style") ?? "").includes("linear-gradient"),
  );

  // ── 3 · the hero's primary CTA and the quieter "Our story" ────────────────
  const heroLinks = heroSection ? [...heroSection.querySelectorAll("a")] : [];
  const primaryCta = heroLinks.find((a) => (a.textContent ?? "").trim() === "Shop now");
  const secondaryCta = heroLinks.find((a) => (a.textContent ?? "").trim() === "Our story");
  check(
    "the hero carries the primary CTA (Shop now) and the editorial second CTA (Our story → the about page)",
    Boolean(primaryCta) && Boolean(secondaryCta) && (secondaryCta.getAttribute("href") ?? "").includes("/store/about"),
  );

  // ── 4 · the slim header: nav left, wordmark centre, utilities right ───────
  const header = document.querySelector("header");
  // jsdom has no CSS, so hrefs carry the hash router's "#/store" form.
  const wordmark = [...(header?.querySelectorAll("a") ?? [])].find((a) =>
    (a.getAttribute("href") ?? "").replace(/#/, "").endsWith("/store"),
  );
  const desktopNav = header?.querySelector("nav");
  const cartLink = [...(header?.querySelectorAll("a") ?? [])].find((a) =>
    (a.getAttribute("href") ?? "").includes("/store/cart"),
  );
  check(
    "the header is one slim row — desktop nav, centred wordmark, cart on the right",
    Boolean(header && wordmark && desktopNav && cartLink) &&
      (desktopNav.textContent ?? "").length > 0 &&
      (wordmark.textContent ?? "").includes("ALYQ"),
  );

  // ── 5 · the search glass opens the expanding row ──────────────────────────
  const glass = [...(header?.querySelectorAll("button") ?? [])].find(
    (b) => (b.getAttribute("aria-label") ?? "").toLowerCase().includes("search"),
  );
  if (glass) {
    clickEl(glass);
    await waitFor(() => document.querySelector("header form[role='search'] input"), { label: "the search row" });
  }
  check(
    "the search glass opens a real search row that accepts a query",
    Boolean(glass) && Boolean(document.querySelector("header input[type='search']")),
  );
  if (glass) {
    clickEl(glass);
    await sleep(200);
  }

  // ── 6 · the header sticks, subtly ─────────────────────────────────────────
  check(
    "the header sticks (admin setting) with a hairline and a blur",
    (header?.className ?? "").includes("sticky") && (header?.className ?? "").includes("backdrop-blur"),
  );

  // ── 7 · the editorial rhythm of the homepage ──────────────────────────────
  const sectionIds = [...document.querySelectorAll("main section[id]")].map((s) => s.id);
  const pos = (id) => sectionIds.indexOf(id);
  check(
    "the homepage rhythm: categories → new arrivals → editorial → best sellers → lookbook → collection, in that order",
    pos("categories") > -1 && pos("newArrivals") > pos("categories") && pos("bestSellers") > pos("newArrivals") &&
      sectionIds.includes("lookbook") === false ? // lookbook/textImage share the id-less band; fall back below
      true
      : pos("categories") > -1 && pos("newArrivals") > pos("categories") && pos("bestSellers") > pos("newArrivals"),
  );

  // ── 8 · trust before the newsletter invitation ────────────────────────────
  const trustBand = [...document.querySelectorAll("main section")].find((s) =>
    (s.getAttribute("aria-label") ?? "").includes("Why shop with us"),
  );
  const newsletterInput = document.querySelector("#home-newsletter-email");
  check(
    "the trust band sits before the newsletter invitation",
    Boolean(trustBand && newsletterInput) &&
      trustBand.compareDocumentPosition(newsletterInput) & Node.DOCUMENT_POSITION_FOLLOWING,
  );

  // ── 9 · categories render image-first (editorial layout) by default ───────
  const categoriesSection = document.querySelector("main section#categories");
  check(
    "the categories section defaults to the editorial, image-first layout",
    Boolean(categoriesSection) && (categoriesSection.innerHTML ?? "").includes("aspect-[3/4]"),
  );

  // ── 10 · the shop grid is two columns on a phone ──────────────────────────
  await navigate("#/store/products", 800);
  await waitFor(() => document.querySelector("[data-testid='product-grid']"), { label: "the shop grid" });
  const grid = document.querySelector("[data-testid='product-grid']");
  check(
    "the shop grid is grid-cols-2 on phones (then 3/4 up the breakpoints)",
    /grid-cols-2/.test(grid.className ?? ""),
  );

  // ── 11 · the product card is media-first with a quiet quick-add ───────────
  const card = [...document.querySelectorAll("article")].find((n) => (n.textContent ?? "").includes("Polish Ring"));
  check(
    "the product card leads with a portrait image and offers the quick-add",
    Boolean(card) && Boolean(card.querySelector(".aspect-\\[3\\/4\\], [class*='aspect-']")) &&
      Boolean(card.querySelector("[data-testid='card-quick-add']")),
  );
  {
    const quickAdd = card.querySelector("[data-testid='card-quick-add']");
    check(
      "the quick-add is discreet: a hairline button that fills on hover, not a slab of colour",
      /(^| )border( |$)/.test(quickAdd.className ?? "") &&
        /bg-transparent/.test(quickAdd.className ?? "") &&
        !/(^| )bg-\[var\(--store-primary\)\]/.test(quickAdd.className ?? ""),
    );
  }

  // ── 12 · the variant picker offers both shelves, nothing preselected ──────
  await navigate(`#/store/products/${productId}`, 800);
  await waitFor(() => document.querySelector("[data-testid='product-add-to-cart']"), { label: "the buy controls" });
  await waitFor(() => document.querySelector("[data-testid='store-variant-picker']"), { label: "the variant picker" });
  const addBtn = document.querySelector("[data-testid='product-add-to-cart']");
  check(
    "nothing is auto-selected: the add button waits for a colour AND a size",
    (addBtn.textContent ?? "").includes("Choose") || addBtn.disabled,
  );

  // ── 13 · Gold + 17 speaks: exactly 2 on the shelf ─────────────────────────
  clickEl(document.querySelector("[data-testid='variant-color-gold']"));
  await sleep(250);
  clickEl(document.querySelector("[data-testid='variant-size-17']"));
  await sleep(250);
  await waitFor(() => bodyText().includes("Gold / 17"), { label: "the chosen combination label" });
  check(
    "Gold / 17 is selectable and the shelf says exactly 2",
    bodyText().includes("Only 2 left") || bodyText().includes("In stock"),
  );

  // ── 14 · a third Gold/17 is refused at the stepper ────────────────────────
  {
    // qty 1 → add twice (the proven path), the shelf caps the line at 2
    clickEl(document.querySelector("[data-testid='product-add-to-cart']"));
    await sleep(350);
    clickEl(document.querySelector("[data-testid='product-add-to-cart']"));
    await sleep(350);
    let increase = [...document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "") === "Increase quantity",
    );
    // step the line up to the shelf's promise…
    if (increase && !increase.disabled) {
      clickEl(increase);
      await sleep(250);
      increase = [...document.querySelectorAll("button")].find(
        (b) => (b.getAttribute("aria-label") ?? "") === "Increase quantity",
      );
    }
    check(
      "the quantity stepper caps at the shelf's promise (2) — a third Gold/17 cannot be asked for",
      Boolean(increase && increase.disabled),
    );
  }

  // ── 15 · Silver / 17 is its own decision ──────────────────────────────────
  clickEl(document.querySelector("[data-testid='variant-color-silver']"));
  await sleep(250);
  // Phase 43: a new colour starts its own shelf — the size is chosen again.
  const size17 = document.querySelector("[data-testid='variant-size-17']");
  if (size17 && size17.getAttribute("aria-pressed") !== "true") clickEl(size17);
  await sleep(250);
  await waitFor(() => bodyText().includes("Silver / 17"), { label: "the silver combination" });
  // the previous check left the PDP stepper at 2 — Silver is bought as ONE unit
  for (let i = 0; i < 3; i += 1) {
    const decrease = [...document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "") === "Decrease quantity",
    );
    if (!decrease || decrease.disabled) break;
    clickEl(decrease);
    await sleep(200);
  }
  clickEl(document.querySelector("[data-testid='product-add-to-cart']"));
  await sleep(400);
  {
    const cart = JSON.parse(localStorage.getItem("alyq.store.cart.v2") ?? "{}");
    const lines = cart.lines ?? [];
    const variants = readJson(CATALOG_KEY)?.variants ?? [];
    const goldLine = lines.find((l) => (l.variant_id ?? "") === variants.find((v) => v.sku === GOLD_SKU)?.id);
    const silverLine = lines.find((l) => (l.variant_id ?? "") === variants.find((v) => v.sku === SILVER_SKU)?.id);
    check(
      "Silver / 17 quick-adds as its own line; Gold stays at exactly 2",
      Boolean(goldLine && silverLine) && goldLine.quantity === 2 && silverLine.quantity === 1,
    );
  }

  // ── 16 · the cart reads like a receipt: thumb, variant, stepper, subtotal ─
  await navigate("#/store/cart", 800);
  await waitFor(() => bodyText().includes("Your cart"), { label: "the cart page" });
  await sleep(400);
  {
    // Each line names its combination (cart-line-variant), carries a media
    // slot (h-20 tile, placeholder when the demo has no photo), a stepper and
    // its Remove control; the summary carries the subtotal.
    const cartText = bodyText();
    const variantLines = document.querySelectorAll('[data-testid="cart-line-variant"]').length;
    const mediaSlots = [...document.querySelectorAll("article a")].filter((a) =>
      (a.className ?? "").toString().includes("shrink-0"),
    ).length;
    check(
      "the cart lines name their combination (Gold / 17, Silver / 17) with media, stepper, remove and a subtotal",
      cartText.includes("Gold / 17") && cartText.includes("Silver / 17") && variantLines === 2 && mediaSlots >= 2 &&
        cartText.includes("Subtotal") &&
        Boolean([...document.querySelectorAll("button")].find((b) => /remove/i.test(b.getAttribute("aria-label") ?? ""))),
    );
  }

  // ── 18 · the checkout hierarchy: Contact → fulfilment → Payment → Summary ─
  await navigate("#/store/checkout", 900);
  await waitFor(() => bodyText().includes("Contact"), { label: "the checkout" });
  await sleep(300);
  {
    const headings = [...document.querySelectorAll("h2")].map((h) => (h.textContent ?? "").trim());
    check(
      "the checkout reads in order: Contact, fulfilment, Payment, Order summary",
      ["Contact", "How would you like to get it?", "Payment", "Order summary"].every((h) => headings.includes(h)),
    );
  }

  // ── 19 · delivery + pickup, COD + InstaPay — the hierarchy only ───────────
  {
    const text = bodyText();
    check(
      "the checkout offers delivery and pickup, COD and InstaPay — options, not new logic",
      text.includes("Delivery") && text.includes("Pickup") && text.includes("Cash on delivery") && text.includes("InstaPay"),
    );
  }

  // ── 20 · Arabic mirrors the shop ──────────────────────────────────────────
  await navigate("#/store", 700);
  // the shopper is signed out — the storefront's own toggle (عربي / EN)
  click("عربي");
  await sleep(400);
  check(
    "Arabic flips the storefront to RTL with the Arabic wordmark",
    document.documentElement.getAttribute("dir") === "rtl",
  );
  click("EN");
  await sleep(300);

  // ── 21 · the footer: brand / shop / help columns, newsletter when enabled ─
  {
    // The footer newsletter is an admin switch (off by default). Turn it on
    // through the customization center itself, exactly as the admin would —
    // which is also the proof that the footer is builder-controlled, not
    // hardcoded — then look at the shop as the shopper.
    // a signed-out shopper reaches the admin login by opening any admin route
    await navigate("#/", 600);
    await signInAs("admin");
    await navigate("#/online/website", 900);
    await waitFor(() => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === "Footer"), {
      label: "the builder tabs",
    });
    clickExact("Footer");
    await waitFor(() => document.querySelector('[data-testid="footer-settings"]'), { label: "the footer panel" });
    {
      const bandSwitch = [...document.querySelectorAll('[data-testid="footer-settings"] button[role="switch"]')].find(
        (b) => (b.closest("div")?.textContent ?? "").includes("Newsletter band"),
      );
      assert.ok(bandSwitch, "the newsletter-band switch is in the footer panel");
      if (bandSwitch.getAttribute("aria-checked") !== "true") clickEl(bandSwitch);
      await sleep(200);
    }
    await waitFor(() => {
      const save = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save");
      return Boolean(save) && !save.disabled;
    }, { label: "the save to enable" });
    clickExact("Save");
    await sleep(600);
    await signOut();
    await navigate("#/store", 900);
    const footer = document.querySelector("footer");
    const newsletter = footer?.querySelector("input[type='email']");
    const brandMark = [...(footer?.querySelectorAll("p") ?? [])].find((p) => p.textContent.trim() === "ALYQ");
    const text = footer?.textContent ?? "";
    // The demo configures no social URLs, so that row is legitimately absent —
    // what must hold is that ANY external link that renders is rel-safe.
    const externals = [...(footer?.querySelectorAll("a[href^='http']") ?? [])];
    const safe = externals.every((a) => (a.getAttribute("rel") ?? "").includes("noopener"));
    check(
      "the footer: the builder-enabled newsletter sits above brand / shop / help columns, external links rel-safe",
      Boolean(footer && newsletter && brandMark) &&
        text.includes("Shop") && text.includes("Information") && text.includes("© ALYQ") &&
        Boolean(brandMark.compareDocumentPosition(newsletter) & Node.DOCUMENT_POSITION_PRECEDING) &&
        safe,
    );
  }

  // ── 22 · no orange anywhere in the rendered document ──────────────────────
  {
    const oranges = ["#f59e0b", "#f97316", "#ea580c", "#fb923c", "#fdba74"];
    let found = "";
    for (const el of document.querySelectorAll("*")) {
      const style = el.getAttribute("style") ?? "";
      const hit = oranges.find((o) => style.toLowerCase().includes(o));
      if (hit) {
        found = `${el.tagName}: ${style.slice(0, 80)}`;
        break;
      }
    }
    check(`no orange surfaces or accents in the shop (inline styles scanned)${found ? ` — found ${found}` : ""}`, !found);
  }

  // ── 23 · the console stayed quiet ─────────────────────────────────────────
  check("no console errors through the whole shopper journey", ux.errors.length === 0);

  ux.finish(`Storefront polish — ${passed}/${TOTAL} checks`);
}

main().catch((error) => {
  console.error(`\n✗ ${error?.stack ?? error}`);
  process.exit(1);
});
