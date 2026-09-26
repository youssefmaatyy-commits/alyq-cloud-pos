import { normalizeText } from "@/modules/products/services/productQuery";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";

/**
 * Scan/search-first register matching (pure, UI-free).
 *
 * The register no longer browses a product-card grid: the cashier scans a
 * barcode or types a name, SKU or product code, and this module decides which
 * sellable products match. Ranking is deterministic — an exact code match
 * always leads — so Enter and the arrow keys act on a stable list.
 *
 * What it deliberately does NOT do: choose a variant. A match names the
 * product; the picker (VariantPicker) still demands the exact combination, and
 * `addBySku` still resolves an exact variant code to its own UUID. Nothing
 * here fabricates colour/size combinations.
 */

/** How many compact rows the result list shows before naming the remainder. */
export const POS_SEARCH_RESULT_CAP = 30;

/** POS sells stock-tracked, active products only — the same rule the grid used. */
export function isPosSellable(product: Product): boolean {
  return product.active && product.stock_tracking_enabled;
}

export interface PosSearchHit {
  product: Product;
  /**
   * True when the query exactly equals a code carried by this product or one
   * of its variants (SKU or barcode, case-insensitive). Exact hits lead the
   * list; the UI still adds through `addBySku`/`addLine`, never from here.
   */
  exactCode: boolean;
}

function codesOf(product: Product, variants: readonly ProductVariant[]): string[] {
  const codes = [product.sku, product.barcode ?? ""];
  for (const variant of variants) {
    if (variant.product_id !== product.id) continue;
    codes.push(variant.sku, variant.barcode ?? "");
  }
  return codes
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);
}

/**
 * Products matching every term of the query, in catalog order with exact code
 * hits first. An empty query matches nothing — the register shows its idle
 * hint, never the whole catalogue.
 */
export function matchPosProducts(
  products: readonly Product[],
  variants: readonly ProductVariant[],
  query: string,
): PosSearchHit[] {
  const needle = normalizeText(query);
  if (!needle) return [];
  const terms = needle.split(" ");
  const wanted = query.trim().toUpperCase();

  const hits: PosSearchHit[] = [];
  for (const product of products) {
    if (!isPosSellable(product)) continue;
    const own = variants.filter((variant) => variant.product_id === product.id);
    const haystack = normalizeText(
      [
        product.name_ar,
        product.name_en,
        product.sku,
        product.barcode ?? "",
        ...own.flatMap((variant) => [variant.sku, variant.barcode ?? ""]),
      ].join(" \u0001 "),
    );
    let matches = true;
    for (const term of terms) {
      if (!haystack.includes(term)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const exactCode = wanted.length > 0 && codesOf(product, own).includes(wanted);
    hits.push({ product, exactCode });
  }
  // Stable: catalog order within each group, exact hits lead.
  hits.sort((a, b) => Number(b.exactCode) - Number(a.exactCode));
  return hits;
}
