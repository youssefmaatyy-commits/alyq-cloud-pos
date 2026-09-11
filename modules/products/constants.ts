import type { ProductType } from "./types";

/** Visual identity per product type — shared by tables, badges and selects. */
export const PRODUCT_TYPE_META: Record<
  ProductType,
  { labelKey: string; hintKey: string; icon: string; tone: string }
> = {
  physical: {
    labelKey: "type.physical",
    hintKey: "type.physical.hint",
    icon: "📦",
    tone: "bg-sky-50 text-sky-700 ring-sky-200",
  },
  service: {
    labelKey: "type.service",
    hintKey: "type.service.hint",
    icon: "🛠️",
    tone: "bg-violet-50 text-violet-700 ring-violet-200",
  },
  manufactured: {
    labelKey: "type.manufactured",
    hintKey: "type.manufactured.hint",
    icon: "🏭",
    tone: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  "serial-tracked": {
    labelKey: "type.serial-tracked",
    hintKey: "type.serial-tracked.hint",
    icon: "🔖",
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  "expiry-tracked": {
    labelKey: "type.expiry-tracked",
    hintKey: "type.expiry-tracked.hint",
    icon: "⏳",
    tone: "bg-rose-50 text-rose-700 ring-rose-200",
  },
} as const;

/** Types that logically require stock tracking. */
export const STOCK_DEFAULT_BY_TYPE: Record<ProductType, boolean> = {
  physical: true,
  service: false,
  manufactured: true,
  "serial-tracked": true,
  "expiry-tracked": true,
};

export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
export const MAX_NAME_LENGTH = 120;
export const MAX_TEXT_LENGTH = 1000;
export const MAX_SKU_LENGTH = 40;
export const MAX_BARCODE_LENGTH = 64;
/** Maximum number of gallery + cover images per product. */
export const MAX_IMAGES = 6;
