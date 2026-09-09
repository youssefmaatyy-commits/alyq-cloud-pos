import type { Category, Product } from "../types";

/**
 * Offline demo dataset used when Supabase is not configured.
 * Values are deliberately realistic bilingual retail records with a spread of
 * stock states (in / low / out), featured flags and website visibility.
 * Demo ids are readable strings — they never reach a real database.
 */

type SeedCategory = Omit<Category, "id" | "created_at" | "updated_at"> & { id: string };
type SeedProduct = Omit<Product, "id" | "created_at" | "updated_at"> & { id: string };

const SEED_TIME = "2026-01-06T09:00:00.000Z";

const C: SeedCategory[] = [
  { id: "cat-beverages", name_ar: "مشروبات", name_en: "Beverages", parent_id: null, active: true, sort_order: 1 },
  { id: "cat-coffee", name_ar: "قهوة", name_en: "Coffee", parent_id: "cat-beverages", active: true, sort_order: 1 },
  { id: "cat-juices", name_ar: "عصائر", name_en: "Juices", parent_id: "cat-beverages", active: true, sort_order: 2 },
  { id: "cat-grocery", name_ar: "بقالة", name_en: "Grocery", parent_id: null, active: true, sort_order: 2 },
  { id: "cat-dairy", name_ar: "ألبان وأجبان", name_en: "Dairy", parent_id: "cat-grocery", active: true, sort_order: 1 },
  { id: "cat-services", name_ar: "خدمات", name_en: "Services", parent_id: null, active: true, sort_order: 3 },
  { id: "cat-office", name_ar: "مستلزمات مكتبية", name_en: "Office Supplies", parent_id: null, active: false, sort_order: 4 },
];

const P: SeedProduct[] = [
  {
    id: "prd-1001",
    sku: "ALYQ-1001",
    barcode: "6281000000013",
    name_ar: "قهوة عربية مطحونة 250غ",
    name_en: "Arabic Ground Coffee 250g",
    description_ar: "تحميص متوسط، عبوة محكمة الإغلاق.",
    description_en: "Medium roast, resealable pouch.",
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
    name_ar: "قهوة مختصة إثيوبية 500غ",
    name_en: "Ethiopian Specialty Coffee 500g",
    description_ar: "حبوب أحادية المصدر، تحميص فاتح.",
    description_en: "Single origin beans, light roast.",
    category_id: "cat-coffee",
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
    name_ar: "عصير برتقال طازج 1 لتر",
    name_en: "Fresh Orange Juice 1L",
    description_ar: "بدون سكر مضاف — يُحفظ مبردًا.",
    description_en: "No added sugar — keep refrigerated.",
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
    name_ar: "حليب طازج كامل الدسم 2 لتر",
    name_en: "Fresh Full-Fat Milk 2L",
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
    name_ar: "مكينة إسبريسو احترافية",
    name_en: "Professional Espresso Machine",
    description_ar: "مجمّعة في الورشة، ضمان سنتان.",
    description_en: "Assembled in-house, two-year warranty.",
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
    name_ar: "خدمة تركيب وتشغيل المكينة",
    name_en: "Machine Installation Service",
    description_ar: "زيارة موقع واحدة، تشمل التدريب الأساسي.",
    description_en: "One site visit, includes basic staff training.",
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
    name_ar: "عقد صيانة سنوي",
    name_en: "Annual Maintenance Contract",
    description_ar: "أربع زيارات سنويًا.",
    description_en: "Four site visits per year.",
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
    name_ar: "كاميرا مراقبة",
    name_en: "CCTV Camera",
    description_ar: "يُباع برقم تسلسلي فريد لكل وحدة.",
    description_en: "Sold with a unique serial per unit.",
    category_id: "cat-grocery",
    product_type: "serial-tracked",
    selling_price: 640,
    cost_price: 470,
    tax_rate: 15,
    stock_tracking_enabled: true,
    stock_quantity: 7,
    low_stock_level: 5,
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
    name_ar: "دفتر ملاحظات A5",
    name_en: "A5 Notebook",
    description_ar: null,
    description_en: null,
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
