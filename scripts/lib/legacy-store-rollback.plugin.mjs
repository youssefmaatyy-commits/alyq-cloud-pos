/** TEST-ONLY projection of the retained legacy shop for rollback regression
 * suites. The production App has *no* legacy/debug route. We compile a separate
 * ephemeral jsdom bundle instead of changing dozens of historical DOM assertions
 * to expect markup that no longer exists, or adding a shopper-facing escape hatch.
 * Public V2 suites always run against the unmodified application bundle.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const app = path.join(root, "src/App.tsx");
const storefront = path.join(root, "src/modules/online/StorefrontApp.tsx");
const start = "                {/* One public V2 tree; old preview bookmarks only redirect.";
const end = '                <Route path="*" element={<Navigate to="/store" replace />} />';
const legacyPages = ["StoreHomePage", "StoreProductsPage", "StoreProductPage", "StoreCartPage",
  "StoreCheckoutPage", "StoreConfirmationPage", "StoreTrackPage", "StoreAccountPage",
  "StoreAboutPage", "StoreContactPage"];
const legacyPaths = ["", "products", "products/:key", "cart", "checkout", "confirmation", "track",
  "account", "about", "contact"];

function projectApp(source) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  if (first < 0 || last < 0) throw new Error("Legacy rollback harness: public storefront route boundary changed");
  // Explicit direct imports keep rollback coverage without pulling the retired
  // presentation through the production online barrel or a public URL.
  const imports = legacyPages.map((page) =>
    `import { ${page} } from "@/modules/online/pages/${page}";`).join("\n") + "\n";
  const importAnchor = 'import { StorefrontV2Home } from "@/modules/online/v2/StorefrontV2Home";';
  if (!source.includes(importAnchor)) throw new Error("Legacy rollback harness: import anchor changed");
  const routes = legacyPaths.map((route, index) => route
    ? `                <Route path="${route}" element={<${legacyPages[index]} />} />`
    : `                <Route index element={<${legacyPages[index]} />} />`).join("\n") + "\n";
  const projected = source.slice(0, first).replace(importAnchor, imports + importAnchor) + routes + source.slice(last);
  return projected.replace(
    /\{\/\* Root public Storefront V2 for all visitors \*\/\}[\s\S]*?<Route index element=\{<StorefrontV2Home \/>\} \/>\s*<\/Route>/,
    '<Route path="/" element={<LegacyStaffRedirect target="/dashboard" />} />',
  );
}

function projectShell(source) {
  const oldImport = 'import { StorefrontV2Shell } from "./v2/StorefrontV2Shell";';
  const oldOutlet = "<StorefrontV2Shell><Outlet /></StorefrontV2Shell>";
  if (!source.includes(oldImport) || !source.includes(oldOutlet)) {
    throw new Error("Legacy rollback harness: storefront shell boundary changed");
  }
  return source.replace(oldImport, 'import { StoreLayout } from "./components/storefront/StoreLayout";')
    .replace(oldOutlet, "<StoreLayout><Outlet /></StoreLayout>");
}

export function legacyStoreRollbackPlugin() {
  return { name: "legacy-store-rollback-test-only", setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]App\.tsx$/ }, () => ({
      contents: projectApp(fs.readFileSync(app, "utf8")), loader: "tsx",
    }));
    build.onLoad({ filter: /[\\/]src[\\/]modules[\\/]online[\\/]StorefrontApp\.tsx$/ }, () => ({
      contents: projectShell(fs.readFileSync(storefront, "utf8")), loader: "tsx",
    }));
  } };
}
