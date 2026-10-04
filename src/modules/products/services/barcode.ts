/**
 * Code 128 barcode encoding + SKU→barcode derivation.
 *
 * Pure, dependency-free and fully unit-testable. The encoder emits module
 * runs (bar/space widths) which the SVG components turn into rectangles, so
 * the same output drives the on-screen preview and the printed label.
 *
 * Subset B is used throughout: it covers the full printable ASCII range
 * (space … `~`), which is what real-world SKUs contain. Subset C (numeric
 * pair compression) is intentionally not used — it produces a shorter symbol
 * but the decoded value is identical, and staying in one subset keeps the
 * encoder trivial to audit.
 */

/** Bar/space width patterns for Code 128 values 0–106. */
const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
] as const;

const START_B = 104;
const STOP = 106;

/** Lowest / highest ASCII code encodable in subset B. */
const MIN_CHAR = 32; // space
const MAX_CHAR = 126; // ~

/** Maximum characters we allow in a barcode payload (keeps symbols scannable). */
export const MAX_BARCODE_PAYLOAD = 48;

export type BarcodeError = "empty" | "unsupportedChar" | "tooLong";

/** A single bar in the rendered symbol, measured in modules. */
export interface BarcodeBar {
  x: number;
  width: number;
}

export interface EncodedBarcode {
  /** Black bars only (spaces are the gaps between them). */
  bars: BarcodeBar[];
  /** Total symbol width in modules, including quiet zones. */
  width: number;
  /** Quiet zone applied on each side, in modules. */
  quietZone: number;
  value: string;
}

/**
 * True when every character can be represented in Code 128 subset B.
 * Arabic text, emoji and control characters are rejected — a barcode payload
 * has to be scanner-safe ASCII.
 */
export function isEncodableCode128(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < MIN_CHAR || code > MAX_CHAR) return false;
  }
  return true;
}

/** Validate a barcode payload, returning a stable error code or `null`. */
export function validateBarcodePayload(value: string): BarcodeError | null {
  const trimmed = value.trim();
  if (!trimmed) return "empty";
  if (trimmed.length > MAX_BARCODE_PAYLOAD) return "tooLong";
  if (!isEncodableCode128(trimmed)) return "unsupportedChar";
  return null;
}

/**
 * Derive the barcode value from a SKU.
 *
 * The rule is deliberately simple and reversible: the SKU *is* the barcode
 * (uppercased, trimmed, inner whitespace collapsed to `-`). Keeping them
 * identical means a POS scan yields the SKU directly, so lookup needs no
 * translation table.
 */
export function deriveBarcodeFromSku(sku: string): string {
  const normalized = sku
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "-")
    // strip anything Code 128 subset B can't represent
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, MAX_BARCODE_PAYLOAD);
}

/** True when `barcode` is exactly what `sku` would generate. */
export function isDerivedFromSku(sku: string, barcode: string | null | undefined): boolean {
  if (!barcode) return false;
  return deriveBarcodeFromSku(sku) === barcode.trim();
}

/**
 * The barcode a SKU field's edit should leave behind, shared by every screen
 * that keeps a barcode "in sync" with a SKU (the product form, the variant
 * editor, the generator).
 *
 * A blank barcode or one that still matches what the OLD sku would have
 * derived is in "auto" mode and follows the new SKU. A barcode that has
 * already diverged (a manufacturer code, a hand-typed override) is a
 * deliberate choice and must never be silently replaced just because the SKU
 * text changed next to it.
 */
export function nextBarcodeOnSkuChange(
  oldSku: string,
  newSku: string,
  currentBarcode: string | null | undefined,
): string {
  const trimmed = (currentBarcode ?? "").trim();
  if (!trimmed || isDerivedFromSku(oldSku, trimmed)) {
    return deriveBarcodeFromSku(newSku);
  }
  return trimmed;
}

/**
 * Encode a value as Code 128 subset B.
 * Throws nothing — returns `null` when the payload can't be encoded so the
 * caller can render a friendly placeholder instead.
 */
export function encodeCode128(value: string, quietZone = 10): EncodedBarcode | null {
  const payload = value.trim();
  if (validateBarcodePayload(payload) !== null) return null;

  // Build the code-point sequence: start, data…, checksum, stop.
  const codes: number[] = [START_B];
  for (const char of payload) {
    codes.push(char.charCodeAt(0) - MIN_CHAR);
  }

  // Modulo-103 weighted checksum (start value has weight 1).
  let checksum = START_B;
  for (let i = 1; i < codes.length; i += 1) {
    checksum += codes[i] * i;
  }
  codes.push(checksum % 103);
  codes.push(STOP);

  // Expand to bar/space runs. Every pattern starts with a bar and alternates.
  const bars: BarcodeBar[] = [];
  let cursor = quietZone;
  for (const code of codes) {
    const pattern = CODE128_PATTERNS[code];
    for (let i = 0; i < pattern.length; i += 1) {
      const runWidth = Number(pattern[i]);
      const isBar = i % 2 === 0;
      if (isBar) bars.push({ x: cursor, width: runWidth });
      cursor += runWidth;
    }
  }

  return {
    bars,
    width: cursor + quietZone,
    quietZone,
    value: payload,
  };
}

/**
 * Render an encoded symbol as a standalone SVG string.
 * Used by the print label (which lives in a separate document and therefore
 * can't reuse the React component).
 */
export function barcodeToSvgString(
  encoded: EncodedBarcode,
  options: { height?: number; moduleWidth?: number; showText?: boolean } = {},
): string {
  const height = options.height ?? 60;
  const moduleWidth = options.moduleWidth ?? 2;
  const showText = options.showText ?? true;
  const textHeight = showText ? 18 : 0;
  const totalWidth = encoded.width * moduleWidth;
  const totalHeight = height + textHeight;

  const rects = encoded.bars
    .map(
      (bar) =>
        `<rect x="${(bar.x * moduleWidth).toFixed(2)}" y="0" width="${(bar.width * moduleWidth).toFixed(2)}" height="${height}" fill="#000"/>`,
    )
    .join("");

  const text = showText
    ? `<text x="${(totalWidth / 2).toFixed(2)}" y="${height + 14}" text-anchor="middle" font-family="monospace" font-size="13" letter-spacing="1" fill="#000">${escapeXml(encoded.value)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" role="img" aria-label="Barcode ${escapeXml(encoded.value)}"><rect width="${totalWidth}" height="${totalHeight}" fill="#fff"/>${rects}${text}</svg>`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Decode helper used by tests (and, later, the POS scanner integration) to
 * prove the encoder round-trips: recompute the checksum from a payload.
 */
export function code128Checksum(payload: string): number {
  let checksum = START_B;
  let position = 1;
  for (const char of payload) {
    checksum += (char.charCodeAt(0) - MIN_CHAR) * position;
    position += 1;
  }
  return checksum % 103;
}
