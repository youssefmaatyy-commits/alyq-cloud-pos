/**
 * esbuild asset mock for the jsdom test bundles.
 *
 * The app imports its brand mark as a module (`@/assets/alyq-logo.png`) in
 * `src/lib/auth/components/LoginPage.tsx`, `src/modules/pos/services/receipt.ts`
 * and `src/modules/storefront/components/StorefrontLayout.tsx`. Plain esbuild
 * has no idea what to do with a binary file, so a bundle of `src/main.tsx`
 * dies before a single suite runs:
 *
 *   ✘ [ERROR] No loader is configured for ".png" files: src/assets/alyq-logo.png
 *
 * The stock loaders do not fit either:
 *
 *   - `file`    writes a real asset next to the outfile and hands back a path
 *               relative to it — meaningless to a bundle in /tmp, and it needs
 *               an `outbase` to stay predictable.
 *   - `dataurl` inlines 31 kB of base64, so `RECEIPT_LOGO_SRC` stops being the
 *               public URL the receipts document and assert
 *               (`public/alyq-logo.README.md`, and
 *               `scripts/smoke.dom.mjs`: `src="/alyq-logo.png"`).
 *   - `empty`   resolves to `undefined`, which would render `src="undefined"`.
 *
 * So assets are mocked the way jest's `fileTransformer` mocks them: the import
 * yields a **stable URL string** and the bytes are never read. The URL is the
 * one Vite would serve in the browser — the site-root path of the matching file
 * in `public/` — which is what the print window actually fetches at runtime and
 * what the suites assert.
 *
 * Deterministic on purpose: the same specifier always produces the same string,
 * so receipt reprint-determinism assertions ("reprinting a sale yields the
 * identical receipt") hold and snapshots never churn.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PUBLIC_DIR = path.join(ROOT, "public");

const NAMESPACE = "alyq-asset-mock";

/** Static asset extensions Vite resolves to a URL. Kept in one list so the two
 *  runners cannot drift apart again (the logic runner was missing `.gif`). */
export const ASSET_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".svg",
];

/** onResolve filters are regular expressions matched against the specifier as
 *  written, so anchor on the extension and tolerate a `?query` / `#fragment`. */
const ASSET_FILTER = new RegExp(
  `\\.(${ASSET_EXTENSIONS.map((ext) => ext.slice(1)).join("|")})([?#].*)?$`,
  "i",
);

/** Already-resolvable URLs must keep their meaning — `data:` thumbnails built
 *  at runtime, absolute CDN links in the demo seed, protocol-relative hosts. */
const isExternalSpecifier = (specifier) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(specifier);

/**
 * The browser-facing URL for an asset specifier.
 *
 * `public/alyq-logo.png` → `/alyq-logo.png` (Vite serves `public/` from the
 * site root). Anything without a `public/` counterpart stands in for Vite's
 * emitted asset path, `/assets/<name>`, so it is still a plausible URL rather
 * than an empty string.
 *
 * @param {string} specifier the import path as written in the source
 * @returns {string} a root-relative URL
 */
export function assetUrl(specifier) {
  const file = specifier.split("?")[0].split("#")[0];
  const base = path.posix.basename(file.replaceAll("\\", "/"));
  if (base === "") return "/assets/asset";
  return fs.existsSync(path.join(PUBLIC_DIR, base)) ? `/${base}` : `/assets/${base}`;
}

/** The JS module an asset import is replaced with — a default-exported URL,
 *  exactly the shape `import alyqLogoUrl from "…png"` expects. */
export const assetModuleContents = (specifier) =>
  `export default ${JSON.stringify(assetUrl(specifier))};\n`;

/**
 * @returns {import("esbuild").Plugin} pass to `esbuild.build({ plugins: […] })`
 */
export function assetMockPlugin() {
  return {
    name: "alyq-asset-mock",
    setup(build) {
      build.onResolve({ filter: ASSET_FILTER }, (args) => {
        if (isExternalSpecifier(args.path)) return undefined; // let esbuild handle it
        return { path: args.path, namespace: NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
        contents: assetModuleContents(args.path),
        loader: "js",
        // Nothing to resolve relative to — the module is self-contained.
        resolveDir: ROOT,
      }));
    },
  };
}

export default assetMockPlugin;
