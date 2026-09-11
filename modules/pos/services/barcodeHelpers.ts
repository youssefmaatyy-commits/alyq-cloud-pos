/**
 * Re-export of the catalog barcode encoder for the POS module.
 * POS must not reach into the products module's internal service paths
 * directly — it consumes the public API surface only.
 */
export {
  encodeCode128,
  barcodeToSvgString,
  escapeXml,
} from "@/modules/products/services/barcode";
