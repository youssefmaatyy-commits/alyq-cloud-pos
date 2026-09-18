/**
 * The shared harness for the Phase 46 UX suites.
 *
 * Every jsdom suite repeated the same sixty lines — the DOM, the blocked
 * network, the console guards, the click/set helpers — and each copy drifted.
 * This module owns that preamble once, so a UX suite is only its scenario:
 *
 *   const ux = await createUxHarness();
 *   await ux.signInAs("admin");
 *   ux.assert.ok(...);
 *   ux.finish("dashboard/UX");
 *
 * The failure rules are the store flow's: ANY console.error, window.onerror,
 * unhandled rejection or network attempt fails the run, because demo mode is
 * localStorage-only and a quiet console is part of the spec.
 */
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

export async function createUxHarness({ beforeImport } = {}) {
  const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });

  const errors = [];

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  } catch {
    /* node owns navigator */
  }
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.FormData = dom.window.FormData;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.File = dom.window.File;
  globalThis.Blob = dom.window.Blob;
  globalThis.FileReader = dom.window.FileReader;
  URL.createObjectURL = (_blob) => `blob:mock-${Math.random().toString(36).slice(2)}`;
  URL.revokeObjectURL = () => {};

  // Demo mode is entirely local — record any attempt to reach the network.
  const networkCalls = [];
  const blockedFetch = (input) => {
    const url = String(typeof input === "object" && input !== null ? (input.url ?? input) : input);
    networkCalls.push(`fetch ${url}`);
    return Promise.reject(new Error(`blocked network call: ${url}`));
  };
  dom.window.fetch = blockedFetch;
  globalThis.fetch = blockedFetch;
  class BlockedXHR {
    open(method, url) {
      networkCalls.push(`${method} ${url}`);
    }
    send() {
      throw new Error(`blocked network call: ${networkCalls.at(-1) ?? "XHR"}`);
    }
    setRequestHeader() {}
    addEventListener() {}
    removeEventListener() {}
  }
  dom.window.XMLHttpRequest = BlockedXHR;
  globalThis.XMLHttpRequest = BlockedXHR;

  // window.open and download anchors would navigate jsdom; record instead.
  const opened = [];
  // document.write capture: the receipt popup writes its HTML here, which is
  // how the branding/POS suites read the printable receipt without a browser.
  const documentWrites = [];
  dom.window.open = (url) => {
    opened.push({ href: String(url ?? ""), download: null });
    return {
      document: {
        open() {},
        write(html) {
          documentWrites.push(String(html ?? ""));
        },
        close() {},
      },
      focus() {},
      print() {},
      close() {},
    };
  };
  const realAnchorClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function () {
    if (this.download || this.target === "_blank") {
      opened.push({ href: this.getAttribute("href") ?? "", download: this.download ?? null });
      return;
    }
    return realAnchorClick.call(this);
  };

  dom.window.console.error = (...args) => {
    errors.push(args.map((a) => (a?.stack ?? String(a))).join(" "));
    process.stderr.write(`[console.error] ${args.map(String).join(" ")}\n`);
  };
  dom.window.addEventListener("error", (event) => errors.push(`window.onerror: ${event.message}`));
  process.on("unhandledRejection", (reason) => {
    errors.push(`unhandledRejection: ${reason?.stack ?? String(reason)}`);
  });

  // A suite may reset the demo storage while the DOM is fresh and the app has
  // not booted yet — the demo repositories seed on boot, so clearing later
  // would destroy the shelf instead of resetting it.
  if (beforeImport) beforeImport({ localStorage: dom.window.localStorage });
  await import("/tmp/alyq-app.mjs");

  // ── helpers ─────────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bodyText = () => document.body.textContent ?? "";

  const waitFor = async (condition, { label, timeout = 15_000, interval = 150 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (condition()) return;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await sleep(interval);
    }
  };

  const navigate = async (hash, settle = 400) => {
    dom.window.location.hash = hash;
    dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
    await sleep(settle);
  };

  const clickEl = (el) =>
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

  const click = (label, scope = document) => {
    const el = [...scope.querySelectorAll("button, a")].find((n) =>
      (n.textContent ?? "").trim().includes(label),
    );
    if (!el) throw new Error(`control not found: ${label}`);
    return clickEl(el);
  };

  const clickExact = (label, scope = document) => {
    const el = [...scope.querySelectorAll("button, a")].find(
      (n) => (n.textContent ?? "").trim() === label,
    );
    if (!el) throw new Error(`control not found (exact): ${label}`);
    return clickEl(el);
  };

  const clickTestid = (testid, scope = document) => {
    const el = scope.querySelector(`[data-testid="${testid}"]`);
    if (!el) throw new Error(`testid not found: ${testid}`);
    return clickEl(el);
  };

  const testid = (testid, scope = document) => scope.querySelector(`[data-testid="${testid}"]`);

  const setNative = (input, proto) => (value) => {
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const setInputValue = (input, value) => {
    const proto =
      input.tagName === "SELECT"
        ? dom.window.HTMLSelectElement
        : input.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement
          : dom.window.HTMLInputElement;
    setNative(input, proto)(value);
  };

  const setField = (selector, value, scope = document) => {
    const input = scope.querySelector(selector);
    if (!input) throw new Error(`field not found: ${selector}`);
    setInputValue(input, value);
    input.dispatchEvent(
      new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
    return input;
  };

  /** The native setter React 19 reads; a plain `.value =` is silently lost. */
  const setReactValue = (input, value) => {
    const proto =
      input.tagName === "SELECT"
        ? dom.window.HTMLSelectElement
        : input.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement
          : dom.window.HTMLInputElement;
    setNative(input, proto)(value);
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };

  const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
  const dialog = () => dialogs()[0] ?? null;
  const topDialog = () => dialogs().at(-1) ?? null;

  const toastText = () =>
    [...document.querySelectorAll('[aria-live="polite"]')].map((n) => n.textContent ?? "").join("\n");

  const readJson = (key) => {
    const raw = globalThis.localStorage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const writeJson = (key, value) => {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
  };

  /** Toggle a SwitchInput-looking checkbox by dispatching a label click. */
  const clickLabel = (label, scope = document) => {
    const el = [...scope.querySelectorAll("label")].find(
      (n) => (n.textContent ?? "").trim().startsWith(label),
    );
    if (!el) throw new Error(`labelled option not found: ${label}`);
    return clickEl(el);
  };

  // ── auth ────────────────────────────────────────────────────────────────
  const DEMO_PASSWORD = "alyq1234";
  const usernameField = () => document.querySelector("input[autocomplete='username']");
  const isSignedIn = () => bodyText().includes("Signed in as");
  const signOut = async () => {
    if (!isSignedIn()) return;
    click("Sign out");
    for (let i = 0; i < 20 && !usernameField(); i += 1) await sleep(200);
    await sleep(200);
  };
  const signInAs = async (username, password = DEMO_PASSWORD) => {
    await signOut();
    await waitFor(() => Boolean(usernameField()), { label: "the login screen" });
    setField("input[autocomplete='username']", username);
    setField("input[autocomplete='current-password']", password);
    click("Sign in");
    await waitFor(() => isSignedIn(), { label: `${username} to sign in` });
    await sleep(400);
  };

  /** Place a website order through the storefront UI (the shopper's journey). */
  const CART_KEY = "alyq.store.cart.v2";
  const addToCartFromStore = async () => {
    await navigate("#/store/products", 800);
    await waitFor(() => document.querySelectorAll("article").length > 0, { label: "the product list" });
    const card = [...document.querySelectorAll("article")].find((c) =>
      [...c.querySelectorAll("button")].some(
        (n) => (n.textContent ?? "").trim() === "Add to cart" && !n.disabled,
      ),
    );
    assert.ok(card, "an addable product card is on the shelf");
    clickExact("Add to cart", card);
    await sleep(400);
  };

  const placeOrder = async ({ payment = "cod", fulfilment = "Pickup" } = {}) => {
    await navigate("#/store/checkout", 700);
    await waitFor(() => bodyText().includes("Checkout"), { label: "the checkout page" });
    setField("input[autocomplete='name']", "Mona Mahmoud");
    setField("input[autocomplete='tel']", "01001234567");
    if (fulfilment) {
      const button = [...document.querySelectorAll("button")].find(
        (n) => (n.textContent ?? "").trim().startsWith(fulfilment),
      );
      if (button) clickEl(button);
      await sleep(200);
    }
    const radio = document.querySelector(`input[name="payment"][value="${payment}"]`);
    if (radio) {
      radio.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(200);
    }
    click("Place the order");
    await waitFor(() => /WEB-\d{6}/.test(bodyText()), { label: "an order number" });
    await sleep(400);
    const number = (bodyText().match(/WEB-\d{6}/) ?? [])[0];
    return number;
  };

  const clearStoreCart = () => {
    try {
      localStorage.removeItem(CART_KEY);
    } catch {
      /* nothing to clear */
    }
  };

  return {
    dom,
    assert,
    errors,
    networkCalls,
    opened,
    documentWrites,
    sleep,
    bodyText,
    waitFor,
    navigate,
    clickEl,
    click,
    clickExact,
    clickTestid,
    clickLabel,
    testid,
    setInputValue,
    setNative,
    setField,
    setReactValue,
    dialogs,
    dialog,
    topDialog,
    toastText,
    readJson,
    writeJson,
    signInAs,
    signOut,
    isSignedIn,
    DEMO_PASSWORD,
    addToCartFromStore,
    placeOrder,
    clearStoreCart,
    finish(title, { skipNetworkCheck = false } = {}) {
      assert.equal(networkCalls.length, 0, `no network in demo mode: ${networkCalls[0] ?? ""}`);
      if (!skipNetworkCheck) assert.deepEqual(errors, [], `no console errors across ${title}`);
      if (errors.length > 0) {
        console.error(`${errors.length} console errors — failing`);
        process.exit(1);
      }
      console.log(`\n${title} passed\n`);
      process.exit(0);
    },
  };
}
