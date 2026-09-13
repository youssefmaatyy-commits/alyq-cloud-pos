import type { Category, Product } from "../types";

/**
 * Offline demo dataset used when Supabase is not configured.
 *
 * Values are deliberately realistic bilingual records for an accessories house,
 * with a spread of stock states (in / low / out), featured flags and website
 * visibility. Demo ids are readable strings — they never reach a real database.
 *
 * Two things here are load-bearing and must survive any edit:
 *
 *   - **the variety.** Five product types, three stock states, a null barcode,
 *     null descriptions, a hidden product, an inactive product inside an inactive
 *     category. Those are not decoration; they are the cases the suites and both
 *     DOM flows exercise, and flattening them would make the tests pass while
 *     testing less.
 *   - **the ordering.** `buildDemoProducts` staggers `created_at` by index, so
 *     the array order IS the "newest first" order the storefront's new-arrivals
 *     section reads. Reordering the array silently reorders that section.
 *
 * Images stay null on purpose. The storefront renders a placeholder, and the demo
 * makes zero network calls — a remote image URL would be the first request the
 * suite has ever caught.
 */

type SeedCategory = Omit<Category, "id" | "created_at" | "updated_at"> & { id: string };
type SeedProduct = Omit<Product, "id" | "created_at" | "updated_at"> & { id: string };

const SEED_TIME = "2026-01-06T09:00:00.000Z";

/**
 * Category ids are technical identifiers and are deliberately unchanged from the
 * dataset they replaced, so anything that refers to a category by id keeps
 * working. Only the names a customer reads were rewritten. `cat-rings` is the one
 * addition: the taxonomy needs it and nothing refers to it yet.
 */
const C: SeedCategory[] = [
  { id: "cat-beverages", name_ar: "مجوهرات", name_en: "Jewellery", parent_id: null, active: true, sort_order: 1 },
  { id: "cat-coffee", name_ar: "أقراط", name_en: "Earrings", parent_id: "cat-beverages", active: true, sort_order: 1 },
  { id: "cat-juices", name_ar: "قلادات", name_en: "Necklaces", parent_id: "cat-beverages", active: true, sort_order: 2 },
  { id: "cat-rings", name_ar: "خواتم", name_en: "Rings", parent_id: "cat-beverages", active: true, sort_order: 3 },
  { id: "cat-grocery", name_ar: "إكسسوارات أزياء", name_en: "Fashion Accessories", parent_id: null, active: true, sort_order: 2 },
  { id: "cat-dairy", name_ar: "أساور", name_en: "Bracelets", parent_id: "cat-grocery", active: true, sort_order: 1 },
  { id: "cat-services", name_ar: "خدمات", name_en: "Services", parent_id: null, active: true, sort_order: 3 },
  { id: "cat-office", name_ar: "إكسسوارات شعر", name_en: "Hair Accessories", parent_id: null, active: false, sort_order: 4 },
];

const P: SeedProduct[] = [
  {
    id: "prd-1001",
    sku: "ALYQ-1001",
    barcode: "6281000000013",
    name_ar: "أقراط لؤلؤ ذهبية",
    name_en: "Gold Pearl Earrings",
    description_ar: "نحاس مطلي بالذهب مع لؤلؤ طبيعي، إغلاق آمن.",
    description_en: "Gold-plated brass with freshwater pearls, secure closure.",
    category_id: "cat-coffee",
    product_type: "physical",
    selling_price: 32.5,
    cost_price: 21,
    tax_rate: 15,
    stock_tracking_enabled: true,
    stock_quantity: 4,
    low_stock_level: 5,
    show_on_website: true,
    is_featured: true,
    active: true,
    image_url: null,
    images: [],
  },
  {
    id: "prd-1002",
    sku: "ALYQ-1002",
    barcode: "6281000000020",
    name_ar: "خاتم ذهبي كلاسيكي",
    name_en: "Classic Gold Ring",
    description_ar: "تصميم بسيط مطلي بالذهب، متوفر بعدة مقاسات.",
    description_en: "A clean gold-plated band, available in several sizes.",
    category_id: "cat-rings",
    product_type: "physical",
    selling_price: 68,
    cost_price: 44.75,
    tax_rate: 15,
    stock_tracking_enabled: true,
    stock_quantity: 42,
    low_stock_level: 10,
    show_on_website: true,
    is_featured: true,
    active: true,
    image_url: null,
    images: [],
  },
  {
    id: "prd-1010",
    sku: "ALYQ-1010",
    barcode: "6281000000037",
    name_ar: "قلادة لؤلؤ",
    name_en: "Pearl Necklace",
    description_ar: "لؤلؤ صناعي على سلسلة رفيعة — تُحفظ في علبتها.",
    description_en: "Faux pearls on a fine chain — keep in its pouch.",
    category_id: "cat-juices",
    product_type: "expiry-tracked",
    selling_price: 14,
    cost_price: 8.5,
    tax_rate: 15,
    stock_tracking_enabled: true,
    stock_quantity: 0,
    low_stock_level: 6,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
  },
  {
    id: "prd-1020",
    sku: "ALYQ-1020",
    barcode: null,
    // Descriptions stay null: this record is the case that proves a product with
    // no copy and no barcode still renders, prices and sells.
    name_ar: "سوار بسيط",
    name_en: "Minimal Bracelet",
    description_ar: null,
    description_en: null,
    category_id: "cat-dairy",
    product_type: "expiry-tracked",
    selling_price: 11.5,
    cost_price: 7.25,
    tax_rate: 15,
    stock_tracking_enabled: true,
    stock_quantity: 18,
    low_stock_level: 8,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
  },
  {
    id: "prd-2001",
    sku: "ALYQ-2001",
    barcode: "6281000000044",
    name_ar: "طقم مجوهرات مصنوع يدويًا",
    name_en: "Handmade Jewellery Set",
    description_ar: "يُجمَّع في الورشة، يشمل قلادة وأقراطًا وسوارًا، ضمان سنتان.",
    description_en: "Assembled in-house — necklace, earrings and bracelet. Two-year warranty.",
    category_id: "cat-grocery",
    product_type: "manufactured",
    selling_price: 4250,
    cost_price: 2980,
    tax_rate: 15,
    stock_tracking_enabled: true,
    stock_quantity: 3,
    low_stock_level: 2,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
  },
  {
    id: "prd-3001",
    sku: "ALYQ-3001",
    barcode: "4006381333931",
    name_ar: "خدمة تغليف الهدايا والنقش",
    name_en: "Gift Wrapping & Personalisation",
    description_ar: "تغليف في المتجر مع نقش الاسم، تشمل جلسة تنسيق قصيرة.",
    description_en: "In-store wrapping with name engraving, includes a short styling session.",
    category_id: "cat-services",
    product_type: "service",
    selling_price: 350,
    cost_price: 0,
    tax_rate: 15,
    stock_tracking_enabled: false,
    stock_quantity: 0,
    low_stock_level: 0,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
  },
  {
    id: "prd-3002",
    sku: "ALYQ-3002",
    barcode: null,
    name_ar: "عضوية التنسيق السنوية",
    name_en: "Annual Styling Membership",
    description_ar: "أربع جلسات تنسيق سنويًا.",
    description_en: "Four styling sessions per year.",
    category_id: "cat-services",
    product_type: "service",
    selling_price: 1800,
    cost_price: 0,
    tax_rate: 15,
    stock_tracking_enabled: false,
    stock_quantity: 0,
    low_stock_level: 0,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
  },
  {
    id: "prd-4001",
    sku: "ALYQ-4001",
    barcode: "6281000000051",
    name_ar: "ساعة بإصدار محدود",
    name_en: "Limited-Edition Watch",
    description_ar: "تُباع برقم تسلسلي فريد لكل وحدة.",
    description_en: "Sold with a unique serial per unit.",
    category_id: "cat-grocery",
    product_type: "serial-tracked",
    selling_price: 640,
    cost_price: 470,
    tax_rate: 15,
    stock_tracking_enabled: true,
    stock_quantity: 7,
    low_stock_level: 5,
    // Hidden and inactive: the case that proves a product the shop does not show
    // cannot be sold or reached from the storefront.
    show_on_website: false,
    is_featured: false,
    active: false,
    image_url: null,
    images: [],
  },
  {
    id: "prd-5001",
    sku: "ALYQ-5001",
    barcode: null,
    name_ar: "مشبك شعر أنيق",
    name_en: "Elegant Hair Clip",
    description_ar: null,
    description_en: null,
    // Inactive, inside an inactive category — the pair the category delete guard
    // and the inactive-filter tests rely on.
    category_id: "cat-office",
    product_type: "physical",
    selling_price: 18,
    cost_price: 9.5,
    tax_rate: 15,
    stock_tracking_enabled: true,
    stock_quantity: 12,
    low_stock_level: 10,
    show_on_website: true,
    is_featured: false,
    active: false,
    image_url: null,
    images: [],
  },
];

export function buildDemoCategories(): Category[] {
  return C.map((c) => ({ ...c, created_at: SEED_TIME, updated_at: SEED_TIME }));
}

export function buildDemoProducts(): Product[] {
  return P.map((p, i) => ({
    ...p,
    created_at: new Date(Date.parse(SEED_TIME) - i * 36e5 * 9).toISOString(),
    updated_at: new Date(Date.parse(SEED_TIME) - i * 36e5 * 4).toISOString(),
  }));
}

/** Wrapper around localStorage that never throws (private mode, quota). */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};
