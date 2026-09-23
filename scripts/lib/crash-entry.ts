/**
 * Test entry for the crash-recovery suite (`scripts/crash.flow.mjs`).
 *
 * This is harness, not application code: nothing in `src/` imports it, it is not
 * part of the app bundle, and `tsconfig.app.json` includes only `src`, so it is
 * never typechecked as product surface. It exists because a crash has to be
 * forced deterministically to be tested, and the real app has no button that
 * throws on purpose.
 *
 * Two deliberate choices about how it is written:
 *
 *   · The crash is armed by a CLICK, not by a function the suite calls, so React
 *     processes the state update inside its own event handler exactly as it does
 *     in a browser. Driving it from Node would need `act()`, and the warning
 *     React emits for a missing `act()` is itself a `console.error` — which is
 *     the very channel this suite asserts against.
 *
 *   · It uses `createElement` rather than JSX and a relative import rather than
 *     the `@/` alias. The shared esbuild options in `lib/app-bundle.mjs` set
 *     neither a `jsx` runtime nor an alias map, and `src/main.tsx` never needed
 *     them to be spelled out; depending on that here would make this file the
 *     only one whose build relies on an inherited default.
 *
 * The thrown error deliberately carries a secret-looking token and a file:line
 * location. `ErrorBoundary` sends both to the console and neither to the screen;
 * the suite asserts the DOM never shows them.
 */
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";

/** Text that must reach a developer's console and never a user's screen. */
export const SECRET = "sk-live-51HsuperSECRETtoken";
export const LOCATION = "src/lib/supabase/client.ts:42";

const thrown = new Set<string>();

function Crasher({ id }: { id: string }) {
  const [boom, setBoom] = useState(false);
  if (boom) {
    thrown.add(id);
    throw new Error(`render failed · ${SECRET} · ${LOCATION}`);
  }
  return createElement(
    "div",
    { "data-probe": `healthy-${id}` },
    createElement("span", null, `subtree ${id} is rendering`),
    createElement(
      "button",
      { type: "button", "data-probe": `crash-${id}`, onClick: () => setBoom(true) },
      `crash ${id}`,
    ),
  );
}

/** The default boundary: the shared "Something went wrong" screen. */
export function mountDefault(container: HTMLElement, id = "solo") {
  const root = createRoot(container);
  root.render(createElement(ErrorBoundary, null, createElement(Crasher, { id })));
  return root;
}

/** The `fallback` prop path the storefront and till boundaries use. */
export function mountCustomFallback(container: HTMLElement, id = "custom", label = "storefront fallback") {
  const root = createRoot(container);
  root.render(
    createElement(
      ErrorBoundary,
      { fallback: createElement("div", { "data-probe": "custom-fallback" }, label) },
      createElement(Crasher, { id }),
    ),
  );
  return root;
}

/**
 * Two boundaries side by side. A crash in one must not blank the other — that is
 * the difference between "this screen broke" and "the application died", and the
 * reason `App.tsx` mounts three boundaries instead of one.
 */
export function mountSiblings(container: HTMLElement) {
  const root = createRoot(container);
  root.render(
    createElement(
      "div",
      null,
      createElement(
        ErrorBoundary,
        { fallback: createElement("div", { "data-probe": "fallback-a" }, "A stopped rendering") },
        createElement(Crasher, { id: "a" }),
      ),
      createElement(
        ErrorBoundary,
        { fallback: createElement("div", { "data-probe": "fallback-b" }, "B stopped rendering") },
        createElement(Crasher, { id: "b" }),
      ),
    ),
  );
  return root;
}

/** True once a subtree has actually thrown, so the suite cannot pass on a no-op. */
export function didThrow(id: string) {
  return thrown.has(id);
}
