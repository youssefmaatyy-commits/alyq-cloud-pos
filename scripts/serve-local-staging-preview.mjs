#!/usr/bin/env node
/** Local-only storefront preview seeded with a read-only Staging snapshot; all POSTs are rejected. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { stagingBr101Snapshot } from "./staging-br101.snapshot.mjs";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const seedPath = new URL("../src/modules/products/data/demoSeed.ts", import.meta.url);
const seedSource = await readFile(seedPath, "utf8");
const seedModule = await transform(seedSource, { loader: "ts", format: "esm" });
const { buildDemoProducts, buildDemoCategories } = await import(
  `data:text/javascript;base64,${Buffer.from(seedModule.code).toString("base64")}`
);
const products = buildDemoProducts();
const parent = { ...products[0], ...stagingBr101Snapshot.product };
products.push(parent);
const categories = [...buildDemoCategories(), ...stagingBr101Snapshot.categories];
const variants = stagingBr101Snapshot.variants.map((model) => ({
  ...model,
  cost_override: null,
  low_stock_level: 1,
  created_at: parent.created_at,
  updated_at: parent.updated_at,
}));
const catalog = { seed_revision: 3, categories, products, variants };
const serialized = JSON.stringify(catalog).replace(/</g, "\\u003c");
const bootstrap = `<script>
(() => {
  const marker = "alyq.local-preview.staging-br101";
  if (localStorage.getItem(marker) === "2026-10-22") return;
  localStorage.setItem("alyq.demo.catalog.v1", ${JSON.stringify(serialized)});
  localStorage.setItem("alyq.lang", "en");
  localStorage.removeItem("alyq.store.cart.v2");
  localStorage.removeItem("alyq.store.account.v2");
  localStorage.setItem(marker, "2026-10-22");
})();
</script>
<style>
#alyq-local-preview-notice{position:fixed;z-index:99999;inset-inline:0;bottom:0;min-height:28px;display:flex;align-items:center;justify-content:center;padding:6px 12px;background:#2d3031;color:#fff;font:600 11px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 -2px 10px #0002}
</style>
<script>addEventListener("DOMContentLoaded",()=>{const n=document.createElement("div");n.id="alyq-local-preview-notice";n.textContent="Local preview · read-only Staging snapshot · checkout is demo-only; no backend order is created";document.body.appendChild(n)});</script>`;
const appScriptMarker = '<script type="module" crossorigin>';
if (!html.includes(appScriptMarker)) throw new Error("The built single-file app script marker was not found.");
const page = html.replace(appScriptMarker, `${bootstrap}${appScriptMarker}`);

const port = Number(process.env.PORT ?? 4173);
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("ok");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }).end("Read-only preview");
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  response.end(request.method === "HEAD" ? undefined : page);
});
server.listen(port, "0.0.0.0", () => {
  console.log(`Local read-only ALYQ Staging snapshot preview listening on 0.0.0.0:${port}`);
  console.log(`Products include the exact three Staging BR101 rows only; POST/PUT/PATCH/DELETE are rejected.`);
});
