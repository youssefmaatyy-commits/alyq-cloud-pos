/**
 * Storefront data — one provider for everything a visitor's page needs.
 *
 * A shop page that fetched its settings, catalogue, content, FAQs, reviews and
 * campaigns separately would paint a half-styled page and then rearrange itself
 * five times. This provider loads them together, then derives the things the
 * screens all need in the same way:
 *
 *   - the campaign-aware `CatalogContext` that search, sorting, badges and
 *     related products read from, so a price is never computed twice with
 *     different answers;
 *   - the visible homepage sections, in the admin's order;
 *   - the brand and price facets the filter sidebar offers.
 *
 * It also owns the storefront's effect on the shared document — theme variables,
 * favicon and `<head>` metadata — and undoes all of it on unmount, because the
 * POS is rendered from the same document and must not inherit a shop's colours.
 *
 * Availability note: in live mode a visitor cannot read other customers'
 * reservations (they are staff rows), so the numbers shown are stock on hand and
 * the authoritative check stays where it belongs — at checkout, inside
 * `place_online_order`. In demo mode the reservations are local, so the pages
 * can show available-to-promise exactly.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Category, Product } from "@/modules/products/types";
import { fetchStorefrontCatalog, type StoreColorImage } from "@/modules/storefront/data/storefrontCatalog";
import { getOnlineMode, getOnlineOrdersRepository, getWebsiteRepository } from "../data";
import { toOnlineError, type CouponCheckInput, type CouponCheckResult, type OnlineMode, type PricingPreview, type PricingPreviewInput } from "../data/repository";
import type {
  Campaign,
  DeliveryZone,
  HomepageSectionConfig,
  OnlineOrder,
  PaymentProofInput,
  ProductContent,
  Promotion,
  PromotionTarget,
  StoreFaq,
  StoreReview,
  WebsiteSettings,
  WebsiteSettingsMeta,
  StorefrontCategoryContent,
} from "../types";
import { resolveSettings } from "../services/settingsDefaults";
import { unitsSold } from "../services/badges";
import { brandsOf, sortStoreVariants, type BrandEntry, type StoreVariant } from "../services/pricing";
import {
  brandFacet,
  categoryFacet,
  priceRangeOf,
  type CatalogContext,
} from "../services/catalogQuery";
import { reservedByProduct } from "../services/availability";
import { visibleSections } from "../services/sections";
import { applyStoreTheme, applyFavicon, clearStoreTheme } from "../services/theme";
import { uploadProofImage } from "../data/localAccounts";
import { storefrontInvalidation } from "./storefrontInvalidation";

export interface StorefrontContextValue {
  mode: OnlineMode;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;

  settings: WebsiteSettings;
  meta: WebsiteSettingsMeta | null;

  products: Product[];
  categories: Category[];
  /**
   * Phase 43: every published combination of every published variant product,
   * in display order. Empty for a catalogue that sells nothing by variant.
   */
  variants: StoreVariant[];
  /** The combinations of one product, display order. */
  variantsOf: (productId: string) => StoreVariant[];
  colorImages: StoreColorImage[];
  /** Selected-colour gallery; empty means fall back to the parent product gallery. */
  colorGalleryFor: (productId: string,colorKey: string|null) => StoreColorImage[];
  contents: ProductContent[];
  contentByProduct: Map<string, ProductContent>;
  faqs: StoreFaq[];
  reviews: StoreReview[];
  campaigns: Campaign[];
  /** Phase 45: the shop-window content of the active categories. */
  categoryContents: StorefrontCategoryContent[];
  /** Enabled delivery zones, admin order — the checkout's choices. */
  deliveryZones: DeliveryZone[];
  /** Live automatic offers (struck-through prices read these). */
  promotions: Promotion[];
  promotionTargets: PromotionTarget[];

  /** Ids of the best-selling products, strongest first. */
  bestSellerIds: string[];
  /** Product id → units sold, for badges and sorting. */
  units: Map<string, number>;
  /** Product id → units held by pending orders (demo mode only). */
  reserved: Map<string, number>;

  /** Ready-made context for `searchCatalog` and friends. */
  catalogContext: CatalogContext;
  /** Visible homepage sections, in the admin's order. */
  sections: HomepageSectionConfig[];
  brands: BrandEntry[];
  brandsFacet: { key: string; label: string; count: number }[];
  categoriesFacet: {
    id: string;
    name_ar: string;
    name_en: string;
    count: number;
  }[];
  priceRange: { min: number; max: number } | null;

  /** Ask whether a typed code works on the current cart. */
  checkCoupon: (input: CouponCheckInput) => Promise<CouponCheckResult>;
  /**
   * The full advisory checkout breakdown — automatic promotion, code, fee and
   * total — without writing anything. The cart and checkout show this;
   * placement recomputes it authoritatively.
   */
  previewPricing: (input: PricingPreviewInput) => Promise<PricingPreview>;
  /** Guest order tracking: number + the phone it was placed with. */
  lookupOrder: (orderNumber: string, phone: string) => Promise<OnlineOrder>;
  /** Submit an InstaPay reference and (optionally) a proof image. */
  submitPaymentProof: (input: PaymentProofInput) => Promise<OnlineOrder>;
  /** Proof image upload, resized before it leaves the device. */
  uploadProofImage: (file: File) => Promise<string>;
}

const StorefrontContext = createContext<StorefrontContextValue | null>(null);

export function useStorefront(): StorefrontContextValue {
  const context = useContext(StorefrontContext);
  if (!context) {
    throw new Error("useStorefront must be used inside <StorefrontProvider>");
  }
  return context;
}

export function StorefrontProvider({ children }: { children: ReactNode }) {
  const mode = getOnlineMode();
  const website = useMemo(() => getWebsiteRepository(), []);
  const orders = useMemo(() => getOnlineOrdersRepository(), []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{
    settings: WebsiteSettings | null;
    meta: WebsiteSettingsMeta | null;
    contents: ProductContent[];
    faqs: StoreFaq[];
    reviews: StoreReview[];
    campaigns: Campaign[];
    categoryContents: StorefrontCategoryContent[];
    deliveryZones: DeliveryZone[];
    promotions: Promotion[];
    promotionTargets: PromotionTarget[];
  }>({
    settings: null,
    meta: null,
    contents: [],
    faqs: [],
    reviews: [],
    campaigns: [],
    categoryContents: [],
    deliveryZones: [],
    promotions: [],
    promotionTargets: [],
  });
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [variants, setVariants] = useState<StoreVariant[]>([]);
  const [colorImages,setColorImages]=useState<StoreColorImage[]>([]);
  const [bestSellers, setBestSellers] = useState<{ product_id: string; units: number }[]>([]);
  const [reservedList, setReservedList] = useState<
    { product_id: string; variant_id: string | null; quantity: number; status: string }[]
  >([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [catalog, site, top] = await Promise.all([
        fetchStorefrontCatalog(),
        website.getSnapshot(),
        website.bestSellers(8),
      ]);
      setVariants(sortStoreVariants(catalog.variants));
      setColorImages(catalog.colorImages);

      // Reservations are staff rows in live mode; asking for them as a visitor
      // would be refused, so only demo mode reads them.
      const holds =
        mode === "demo"
          ? await orders
              .listReservations()
              .then((rows) => rows.filter((row) => row.status === "reserved"))
              .catch(() => [])
          : [];

      setProducts(catalog.products);
      setCategories(catalog.categories);
      setSnapshot({
        settings: site.settings,
        meta: site.meta,
        contents: site.contents,
        faqs: site.faqs,
        reviews: site.reviews,
        campaigns: site.campaigns,
        categoryContents: site.categoryContents ?? [],
        deliveryZones: site.deliveryZones ?? [],
        promotions: site.promotions ?? [],
        promotionTargets: site.promotionTargets ?? [],
      });
      setBestSellers(top);
      setReservedList(holds);
      setError(null);
    } catch (caught) {
      setError(toOnlineError(caught).message);
    } finally {
      setLoading(false);
    }
  }, [mode, orders, website]);

  useEffect(() => {
    void load();
  }, [load]);

  // Cross-tree invalidation: admin pages (MarketingPage, PromotionsPage,
  // DeliveryZonesPage) notify after successful writes so the storefront
  // refetches its snapshot without a full remount.
  useEffect(() => {
    return storefrontInvalidation.subscribe(() => {
      void load();
    });
  }, [load]);

  const settings = useMemo(
    () => resolveSettings(snapshot.settings),
    [snapshot.settings],
  );

  // The storefront's mark on the shared document, and its removal.
  useEffect(() => {
    applyStoreTheme(settings);
    applyFavicon(settings.images.favicon_url);
    return () => {
      clearStoreTheme();
    };
  }, [settings]);

  const contentByProduct = useMemo(
    () => new Map(snapshot.contents.map((content) => [content.product_id, content])),
    [snapshot.contents],
  );

  const units = useMemo(() => {
    if (bestSellers.length > 0) {
      return new Map(bestSellers.map((row) => [row.product_id, row.units]));
    }
    // Nothing has sold yet: derive from the catalogue's own history if we have
    // it, otherwise the badges simply do not appear.
    return unitsSold({ sales: [], onlineOrders: [] });
  }, [bestSellers]);

  const reserved = useMemo(
    () =>
      reservedByProduct(
        reservedList.map((row) => ({
          id: row.product_id,
          online_order_id: "",
          product_id: row.product_id,
          variant_id: null,
          quantity: row.quantity,
          status: row.status as "reserved",
          created_at: "",
          resolved_at: null,
        })),
      ),
    [reservedList],
  );

  // The same holds, per exact combination: what a pending order is holding of
  // Gold / 17 specifically. Demo mode again — live visitors cannot read holds,
  // and checkout re-checks them server-side either way.
  const reservedVariant = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of reservedList) {
      if (row.status !== "reserved" || !row.variant_id) continue;
      totals.set(row.variant_id, (totals.get(row.variant_id) ?? 0) + row.quantity);
    }
    return totals;
  }, [reservedList]);

  const variantsByProduct = useMemo(() => {
    const grouped = new Map<string, StoreVariant[]>();
    for (const variant of variants) {
      const list = grouped.get(variant.product_id);
      if (list) list.push(variant);
      else grouped.set(variant.product_id, [variant]);
    }
    return grouped;
  }, [variants]);

  const variantsOf = useCallback(
    (productId: string) => variantsByProduct.get(productId) ?? [],
    [variantsByProduct],
  );

  const colorGalleryFor=useCallback((productId:string,colorKey:string|null)=>
    colorImages.filter((image)=>image.product_id===productId && image.color_key===(colorKey??""))
      .sort((a,b)=>Number(b.is_primary)-Number(a.is_primary)||a.sort_order-b.sort_order),[colorImages]);

  const catalogContext = useMemo<CatalogContext>(
    () => ({
      campaigns: snapshot.campaigns,
      units,
      contents: contentByProduct,
      reserved,
      variants: variantsByProduct,
      reservedVariant,
    }),
    [snapshot.campaigns, units, contentByProduct, reserved, variantsByProduct, reservedVariant],
  );

  const sections = useMemo(() => visibleSections(settings), [settings]);

  const visibleIds = useMemo(
    () => new Set(products.filter((product) => product.active && product.show_on_website).map((product) => product.id)),
    [products],
  );

  const brands = useMemo(
    () =>
      brandsOf(
        snapshot.contents,
        (arabic, english) => english?.trim() || arabic?.trim() || "",
        visibleIds,
      ),
    [snapshot.contents, visibleIds],
  );

  const brandsFacet = useMemo(
    () => brandFacet(products, snapshot.contents),
    [products, snapshot.contents],
  );

  const categoriesFacet = useMemo(
    () => categoryFacet(products, categories.filter((category) => category.active)),
    [products, categories],
  );

  const priceRange = useMemo(
    () => priceRangeOf(products, catalogContext),
    [products, catalogContext],
  );

  const checkCoupon = useCallback(
    (input: CouponCheckInput) => website.checkCoupon(input),
    [website],
  );

  const previewPricing = useCallback(
    (input: PricingPreviewInput) => website.previewPricing(input),
    [website],
  );

  const lookupOrder = useCallback(
    (orderNumber: string, phone: string) => orders.lookupOrder(orderNumber, phone),
    [orders],
  );

  const submitPaymentProof = useCallback(
    (input: PaymentProofInput) => orders.submitPaymentProof(input),
    [orders],
  );

  const uploadProof = useCallback((file: File) => uploadProofImage(file), []);

  const value = useMemo<StorefrontContextValue>(
    () => ({
      mode,
      loading,
      error,
      refresh: load,
      settings,
      meta: snapshot.meta,
      products,
      categories,
      variants,
      variantsOf,
      colorImages,
      colorGalleryFor,
      contents: snapshot.contents,
      contentByProduct,
      faqs: snapshot.faqs,
      reviews: snapshot.reviews,
      campaigns: snapshot.campaigns,
      categoryContents: snapshot.categoryContents,
      deliveryZones: snapshot.deliveryZones,
      promotions: snapshot.promotions,
      promotionTargets: snapshot.promotionTargets,
      bestSellerIds: bestSellers.map((row) => row.product_id),
      units,
      reserved,
      catalogContext,
      sections,
      brands,
      brandsFacet,
      categoriesFacet,
      priceRange,
      checkCoupon,
      previewPricing,
      lookupOrder,
      submitPaymentProof,
      uploadProofImage: uploadProof,
    }),
    [
      mode,
      loading,
      error,
      load,
      settings,
      snapshot,
      products,
      categories,
      variants,
      variantsOf,
      colorImages,
      colorGalleryFor,
      contentByProduct,
      bestSellers,
      units,
      reserved,
      reservedVariant,
      catalogContext,
      sections,
      brands,
      brandsFacet,
      categoriesFacet,
      priceRange,
      checkCoupon,
      previewPricing,
      lookupOrder,
      submitPaymentProof,
      uploadProof,
    ],
  );

  return <StorefrontContext.Provider value={value}>{children}</StorefrontContext.Provider>;
}
