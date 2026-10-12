import { resolveApplicationConfig } from '../../src/lib/config/application-mode.mjs';

/** Anonymous, read-only GETs of STABLE public RPCs. Never table writes or staff data.
 * This proves storefront stock-on-hand, not the private reservation ledger. Checkout
 * remains authoritative for availability-to-promise and pricing under concurrency.
 */
export async function probeCatalogue(env, { fetchImpl = globalThis.fetch } = {}) {
  const config = resolveApplicationConfig(env);
  if (!config.ok || config.mode !== 'production') throw new Error('Catalogue probe requires valid Production-mode configuration.');
  if (env.ALLOW_EMPTY_STOREFRONT && !['true', 'false'].includes(env.ALLOW_EMPTY_STOREFRONT)) {
    throw new Error('ALLOW_EMPTY_STOREFRONT must be explicitly true or false.');
  }
  const readRpc = async (rpc, args = {}, array = true) => {
    try {
      const url = new URL(`${config.supabaseUrl}/rest/v1/rpc/${rpc}`);
      for (const [name, value] of Object.entries(args)) url.searchParams.set(name, value);
      const response = await fetchImpl(url.toString(), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('RPC_UNAVAILABLE');
      const text = await response.text();
      if (text.length > 4_000_000) throw new Error('RPC_RESPONSE_TOO_LARGE');
      const rows = JSON.parse(text);
      if (array ? !Array.isArray(rows) : !rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('RPC_RESPONSE_INVALID');
      return rows;
    } catch {
      // Never print a URL, header, raw response or provider error, even on failure.
      throw new Error('Public catalogue RPC unavailable or malformed; release blocked.');
    }
  };
  const [products, variants] = await Promise.all([
    readRpc('storefront_catalogue'), readRpc('storefront_branch_product_variants'),
  ]);
  const hasStock = (row) => Number.isInteger(Number(row.stock_quantity)) && Number(row.stock_quantity) > 0;
  const hasPrice = (price) => Number.isFinite(Number(price)) && Number(price) > 0;
  const eligible = products.filter((product) => {
    if (!product || typeof product.id !== 'string' || product.active !== true || product.show_on_website !== true) return false;
    const shelves = variants.filter((variant) => variant?.product_id === product.id);
    if (product.variants_enabled === true || shelves.length > 0) {
      return shelves.some((variant) => variant.active === true && hasStock(variant) && hasPrice(variant.price_override ?? product.selling_price));
    }
    return hasPrice(product.selling_price) && (product.stock_tracking_enabled === false || (product.stock_tracking_enabled === true && hasStock(product)));
  });
  const sellable = eligible.length;
  if (sellable === 0 && env.ALLOW_EMPTY_STOREFRONT !== 'true') {
    throw new Error('Zero sellable public products; commercial release blocked. New/staging stores require explicit ALLOW_EMPTY_STOREFRONT=true.');
  }
  if (sellable > 0) {
    // The public catalogue omits variants_enabled. A positive rollup with NO
    // active shelves is not proof of a plain product. A STABLE pricing GET
    // verifies that an eligible representative is actually selectable (including
    // the exact variant), without placing an order or reserving any stock.
    const product = eligible[0];
    const variant = variants.find((row) => row?.product_id === product.id && row.active === true && hasStock(row) && hasPrice(row.price_override ?? product.selling_price));
    const line = { product_id: product.id, variant_id: variant?.id ?? null, qty: 1 };
    const price = await readRpc('preview_storefront_pricing', { p_lines: JSON.stringify([line]), p_delivery_type: 'pickup' }, false);
    if (!Array.isArray(price.lines) || price.lines.length !== 1
        || price.lines[0]?.product_id !== line.product_id || (price.lines[0]?.variant_id ?? null) !== line.variant_id
        || Number(price.lines[0]?.qty) !== 1 || !Number.isFinite(Number(price.total)) || Number(price.total) < 0) {
      throw new Error('Public representative pricing invalid; commercial release blocked.');
    }
  }
  return Object.freeze({ productCount: products.length, sellableCount: sellable, allowedEmpty: sellable === 0 });
}
