import type {
  Category,
  CategoryPatch,
  NewCategory,
  NewProduct,
  Product,
  ProductPatch,
} from "../types";
import type {
  NewProductVariant, ProductColorImage, ProductColorImageInput, ProductVariant, ProductVariantPatch,
} from "../variants";
import { colorKeyOf, compareVariants, variantLabel, variantSizeValue } from "../variants";
import {
  AppError,
  type CatalogRepository,
  type ProductReferenceMap,
  type VariantActor,
  type VariantOpening,
  type VariantReferenceMap,
} from "./repository";
import { buildDemoCategories, buildDemoProducts, safeStorage } from "./demoSeed";
import { demoProductReferences, demoVariantReferences } from "./productReferences";
import { demoStocktakeBlocksProduct, demoStocktakeBlocksVariant } from "@/modules/inventory/services/stocktake";

const STORAGE_KEY = "alyq.demo.catalog.v1";
const LATENCY = 140;

/**
 * Which revision of the demo range this build seeds.
 *
 * Bumped when `buildDemoProducts` / `buildDemoCategories` are rewritten, so a
 * browser that cached an earlier default catalogue picks up the replacement on
 * its next load instead of serving a retired range forever. Without it the shop
 * keeps showing whatever it was first seeded with, and a catalogue change only
 * ever reaches a fresh profile.
 *
 * The storage key deliberately does *not* move with the revision. That key is
 * part of the backup module's contract — `backup/schema.ts` lists it,
 * `backup/services/health.ts` reads products and categories out of it, and both
 * the backup suite and the backup flow assert on it — so renaming it would
 * orphan every snapshot already taken. The revision travels inside the state
 * instead: a snapshot restores carrying the revision it was taken at, and is
 * therefore left exactly as it was.
 */
const SEED_REVISION = 3;

interface DemoState {
  categories: Category[];
  products: Product[];
  /**
   * Phase 43: the variants of every product, in one flat list (the shape the
   * repository contract uses, and the shape the live table has). Storage stays
   * on this same key so an existing snapshot keeps restoring.
   */
  variants: ProductVariant[];
  color_images: ProductColorImage[];
  /** Stamp of the default range this state came from — see SEED_REVISION. */
  seed_revision?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * Demo-mode repository: same contract as the Supabase repository, backed by
 * browser localStorage. Enforces the same uniqueness rules so the UI behaves
 * identically in both modes.
 */
export class DemoRepository implements CatalogRepository {
  readonly kind = "demo" as const;
  private state: DemoState;

  constructor() {
    this.state = this.load();
  }

  private load(): DemoState {
    const raw = safeStorage.get(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as DemoState;
        if (
          Array.isArray(parsed.categories) &&
          Array.isArray(parsed.products) &&
          parsed.seed_revision === SEED_REVISION
        ) {
          // A blob written by a build that predates variants on the same
          // revision would leave the key undefined; normalise rather than
          // crash on the first `listVariants()`.
          return {
            ...parsed,
            variants: Array.isArray(parsed.variants) ? parsed.variants : [],
            color_images: Array.isArray(parsed.color_images) ? parsed.color_images : [],
          };
        }
        /* Otherwise fall through: the blob is either damaged, or it holds a
           default range this build has since replaced. */
      } catch {
        /* fall through to reseed */
      }
    }
    const seeded: DemoState = {
      categories: buildDemoCategories(),
      products: buildDemoProducts(),
      variants: [],
      color_images: [],
      seed_revision: SEED_REVISION,
    };
    this.persist(seeded);
    return seeded;
  }

  private persist(state: DemoState = this.state): void {
    safeStorage.set(STORAGE_KEY, JSON.stringify(state));
  }

  // ── products ───────────────────────────────────────────────────────────

  listProducts(): Promise<Product[]> {
    return delay([...this.state.products]);
  }

  async createProduct(input: NewProduct): Promise<Product> {
    this.assertUniqueSku(input.sku);
    if (input.barcode) this.assertUniqueBarcode(input.barcode);
    // Mirrors products_enforce_category_active (0044): even a forged direct
    // call cannot shelve a product under an archived category.
    this.assertCategoryAssignable(input.category_id, "create");
    const product: Product = {
      ...input,
      // The column is NOT NULL DEFAULT false in the database; the demo state
      // mirrors that rather than carrying an absent flag around.
      variants_enabled: input.variants_enabled ?? false,
      id: this.newId("prd"),
      ...timestamps(),
    };
    this.state.products = [product, ...this.state.products];
    this.persist();
    return delay(product, 60);
  }

  async updateProduct(id: string, patch: ProductPatch): Promise<Product> {
    const index = this.state.products.findIndex((p) => p.id === id);
    if (index === -1) throw new AppError("NOT_FOUND");
    const current = this.state.products[index];

    // Correction 1/6, demo side: a variant product's stock is the rollup of its
    // variants, so a direct write to it is refused the same way the live
    // `products_block_direct_stock_write` trigger refuses one. No capability
    // changes this — an inventory clerk with `adjust_stock` adjusts a VARIANT,
    // and the rollup follows; nobody edits the total by hand.
    if (patch.stock_quantity !== undefined && patch.stock_quantity !== current.stock_quantity) {
      if (current.variants_enabled) {
        throw new AppError(
          "VARIANT_STOCK_READONLY",
          `${current.sku} sells by variant — adjust the variant's stock instead`,
          "stock_quantity",
          "23514",
        );
      }
    }

    const next: Product = { ...current, ...patch };
    if (patch.sku !== undefined) {
      this.assertUniqueSku(patch.sku, id);
    }
    if (patch.barcode) {
      this.assertUniqueBarcode(patch.barcode, id);
    }
    this.assertCategoryAssignable(next.category_id, "update");
    next.updated_at = nowIso();
    const updated = [...this.state.products];
    updated[index] = next;
    this.state.products = updated;
    this.persist();
    return delay(next, 60);
  }

  async setProductActive(id: string, active: boolean): Promise<Product> {
    return this.updateProduct(id, { active });
  }

  async listProductReferences(): Promise<ProductReferenceMap> {
    return delay(demoProductReferences(), 20);
  }

  /**
   * The demo-mode half of `public.delete_product` (0037). The guard lives here
   * and not only in the service layer for the same reason the SQL check lives
   * in the function and not only in the app: this repository is the demo
   * "server", so the lifecycle rule holds no matter which caller skips the
   * screen. A product referenced by any demo sale, return, stock movement,
   * online order or reservation is refused; only a truly unused product is
   * removed.
   */
  async deleteProduct(id: string): Promise<void> {
    const exists = this.state.products.some((p) => p.id === id);
    if (!exists) throw new AppError("NOT_FOUND", `Product ${id} not found`);
    const references = demoProductReferences()[id];
    if (references && references.total > 0) {
      throw new AppError(
        "PRODUCT_HAS_HISTORY",
        `Product ${id} has historical transactions and cannot be permanently deleted`,
      );
    }
    if (demoStocktakeBlocksProduct(id)) {
      throw new AppError(
        "PRODUCT_HAS_HISTORY",
        `Product ${id} has stocktake history and cannot be permanently deleted`,
      );
    }
    this.state.products = this.state.products.filter((p) => p.id !== id);
    this.persist();
    await delay(undefined, 60);
  }

  // ── variants (Phase 43) ────────────────────────────────────────────────
  //
  // This repository is the demo "server", so the variant rules live here the
  // same way they live in migration 0043's functions: the identity of a
  // combination, the rollup, the conversion invariants and the delete guard all
  // hold no matter which caller skips the screen. A UI bug can therefore show a
  // wrong label, but it cannot make demo stock disagree with demo sales — which
  // is what keeps the offline mode a truthful rehearsal of the live one.

  listVariants(): Promise<ProductVariant[]> {
    return delay([...this.state.variants].sort(compareVariantRows));
  }

  listColorImages(productId?: string): Promise<ProductColorImage[]> {
    const rows = this.state.color_images
      .filter((image) => !productId || image.product_id === productId)
      .sort((a,b) => a.color_key.localeCompare(b.color_key) || Number(b.is_primary)-Number(a.is_primary) || a.sort_order-b.sort_order);
    return delay([...rows]);
  }

  replaceColorImages(productId: string, images: readonly ProductColorImageInput[]): Promise<ProductColorImage[]> {
    if (!this.state.products.some((product) => product.id === productId)) {
      throw new AppError("NOT_FOUND", `Product ${productId} not found`);
    }
    const now=nowIso();
    const next=images.map((image,index):ProductColorImage=>({
      ...image,
      id:this.newId("cimg"),
      product_id:productId,
      color_key:image.color_key.trim().toLocaleLowerCase(),
      image_url:image.image_url.trim(),
      sort_order:index,
      is_primary:index===0 || image.is_primary,
      created_at:now,
      updated_at:now,
    }));
    const primary=new Set<string>();
    for(const image of next){
      if(primary.has(image.color_key)) image.is_primary=false;
      else { image.is_primary=true; primary.add(image.color_key); }
    }
    this.state.color_images=[...this.state.color_images.filter((image)=>image.product_id!==productId),...next];
    this.persist();
    return delay(next);
  }

  async createVariant(input: NewProductVariant): Promise<ProductVariant> {
    const product = this.state.products.find((p) => p.id === input.product_id);
    if (!product) throw new AppError("NOT_FOUND", `Product ${input.product_id} not found`);

    const sku = input.sku.trim();
    if (!sku) throw new AppError("VALIDATION", "A variant needs a SKU", "sku");
    this.assertUniqueVariantCode("sku", sku);
    if (input.barcode) this.assertUniqueVariantCode("barcode", input.barcode.trim());

    const variant: ProductVariant = {
      ...input,
      sku,
      barcode: input.barcode?.trim() || null,
      // Identity from the label ONCE (correction 2): a rename later moves the
      // display text, never the identity.
      color_key: input.color_key?.trim() || colorKeyOf(input),
      stock_quantity: Math.max(0, Math.trunc(input.stock_quantity)),
      low_stock_level: Math.max(0, Math.trunc(input.low_stock_level)),
      size_value: (input.size_value ?? input.size_label ?? (input.size == null ? "" : String(input.size))).trim() || null,
      size_sort_order: Math.max(0, Math.trunc(input.size_sort_order ?? input.sort_order)),
      ...timestamps(),
      id: this.newId("var"),
    };
    this.assertVariantIdentityFree(variant);
    this.state.variants = [...this.state.variants, variant];
    this.syncProductRollup(product.id);
    this.persist();
    return delay(variant, 60);
  }

  async updateVariant(id: string, patch: ProductVariantPatch): Promise<ProductVariant> {
    const index = this.state.variants.findIndex((v) => v.id === id);
    if (index === -1) throw new AppError("VARIANT_NOT_FOUND", `Variant ${id} not found`);
    const current = this.state.variants[index];

    if (patch.sku !== undefined) {
      const sku = patch.sku.trim();
      if (!sku) throw new AppError("VALIDATION", "A variant needs a SKU", "sku");
      this.assertUniqueVariantCode("sku", sku, id);
    }
    if (patch.barcode) this.assertUniqueVariantCode("barcode", patch.barcode.trim(), id);

    // Omitted patch fields stay on the shelf. In particular an explicitly
    // undefined stock field must never erase the current quantity (or poison
    // the parent's derived stock with NaN). The live JSON update also omits it.
    const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as ProductVariantPatch;
    const next: ProductVariant = {
      ...current,
      ...definedPatch,
      // The identity is captured once and never rewritten by a rename.
      color_key: current.color_key,
      updated_at: nowIso(),
    };
    if (!next.color_key) {
      next.color_key = colorKeyOf({
        color_en: next.color_en ?? "",
        color_ar: next.color_ar ?? "",
      });
    }
    if (next.product_id !== current.product_id) {
      throw new AppError("VALIDATION", "A variant cannot move to another product", "product_id");
    }
    if (patch.stock_quantity !== undefined) {
      // Stock moves through the inventory funnel (`adjustVariantStock`), which
      // writes a movement. Editing it straight onto the row would leave the
      // ledger and the shelf disagreeing.
      throw new AppError(
        "VARIANT_STOCK_READONLY",
        "Variant stock changes through a stock adjustment, so the movement ledger records it",
        "stock_quantity",
      );
    }
    const identityChanged =
      next.color_key !== current.color_key ||
      variantSizeValue(next).toLocaleLowerCase() !== variantSizeValue(current).toLocaleLowerCase();
    if (identityChanged) {
      // A combination IS its colour and size; editing those would move the row
      // onto another shelf. Archive it and create the right one.
      throw new AppError(
        "VALIDATION",
        "A variant is identified by its colour and size — archive it and add the combination instead",
        "size",
      );
    }

    if (current.active && !next.active && this.state.products.find((p) => p.id === current.product_id)?.variants_enabled &&
        !this.state.variants.some((sibling) => sibling.product_id === current.product_id && sibling.id !== id && sibling.active)) {
      throw new AppError("VARIANT_REQUIRED", `Product must keep at least one active combination`, "active");
    }
    this.assertVariantIdentityFree(next, id);
    const updated = [...this.state.variants];
    updated[index] = next;
    this.state.variants = updated;
    this.persist();
    return delay(next, 60);
  }

  async setVariantActive(id: string, active: boolean): Promise<ProductVariant> {
    // updateVariant enforces the same last-active-shelf rule as the live RPC,
    // including callers that skip the service or the page entirely.
    return this.updateVariant(id, { active });
  }

  async deleteVariant(id: string): Promise<void> {
    const variant = this.state.variants.find((v) => v.id === id);
    if (!variant) throw new AppError("VARIANT_NOT_FOUND", `Variant ${id} not found`);
    const product = this.state.products.find((p) => p.id === variant.product_id);

    if (product?.variants_enabled) {
      const siblings = this.state.variants.filter((v) => v.product_id === variant.product_id);
      // An archived sibling is not a sellable replacement. Deleting the only
      // active shelf would strand the enabled product even though rows remain.
      if (siblings.length <= 1 || (variant.active && !siblings.some((other) => other.id !== id && other.active))) {
        throw new AppError(
          "VARIANT_REQUIRED",
          `Product ${product.sku} must keep at least one active combination`,
        );
      }
    }
    const references = demoVariantReferences()[id] ?? 0;
    if (references > 0) {
      throw new AppError(
        "VARIANT_IN_USE",
        `${variantLabel(variant)} has ${references} historical record(s); archive it instead`,
      );
    }
    if (demoStocktakeBlocksVariant(id)) {
      throw new AppError(
        "VARIANT_IN_USE",
        `${variantLabel(variant)} is named by a stocktake; archive it instead`,
      );
    }
    this.state.variants = this.state.variants.filter((v) => v.id !== id);
    if (variant.product_id) this.syncProductRollup(variant.product_id);
    this.persist();
    await delay(undefined, 60);
  }

  listVariantReferences(): Promise<VariantReferenceMap> {
    return delay(demoVariantReferences(), 20);
  }

  /**
   * Switch a product to variant stock (correction 1).
   *
   * The sum of the opening distribution must equal what the product already
   * holds: the conversion never creates or destroys a unit and never defaults
   * the existing stock onto whichever variant happens to be first. Each unit is
   * then written to the ledger by the caller (`enableVariants` service), which
   * is why this returns the distribution it accepted.
   */
  async enableProductVariants(
    productId: string,
    opening: readonly VariantOpening[],
    actor: VariantActor,
  ): Promise<Product> {
    void actor; // demo mode: the service writes the audit row, see variantService.
    const product = this.state.products.find((p) => p.id === productId);
    if (!product) throw new AppError("NOT_FOUND", `Product ${productId} not found`);
    if (product.variants_enabled) return delay(product, 40);

    const mine = this.state.variants.filter((v) => v.product_id === productId);
    if (mine.length === 0) {
      throw new AppError("VALIDATION", `Add at least one variant before switching ${product.sku}`);
    }

    const known = new Set(mine.map((v) => v.id));
    const byId = new Map<string, number>();
    for (const entry of opening) {
      if (!known.has(entry.variantId)) {
        throw new AppError(
          "VARIANT_NOT_FOUND",
          `The opening quantities name a variant that does not belong to ${product.sku}`,
        );
      }
      const quantity = Math.trunc(entry.quantity);
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw new AppError("VARIANTS_STOCK_MISMATCH", "Opening quantities must be whole units");
      }
      byId.set(entry.variantId, (byId.get(entry.variantId) ?? 0) + quantity);
    }

    const total = mine.reduce((sum, v) => sum + (byId.get(v.id) ?? 0), 0);
    if (total !== product.stock_quantity) {
      throw new AppError(
        "VARIANTS_STOCK_MISMATCH",
        `The opening quantities add up to ${total}, but ${product.sku} holds ${product.stock_quantity} — the conversion must neither create nor destroy stock`,
      );
    }

    this.state.variants = this.state.variants.map((v) =>
      v.product_id === productId
        ? { ...v, stock_quantity: byId.get(v.id) ?? 0, updated_at: nowIso() }
        : v,
    );
    return this.patchProduct(productId, { variants_enabled: true, stock_quantity: total });
  }

  /**
   * Leave variant mode (correction 4). Allowed only while no history names a
   * variant, only with an explicit consolidated figure, and only when that
   * figure equals what the variants hold — nothing is collapsed silently.
   */
  async disableProductVariants(
    productId: string,
    consolidatedStock: number,
    actor: VariantActor,
  ): Promise<Product> {
    void actor; // demo mode: the service writes the audit row, see variantService.
    const product = this.state.products.find((p) => p.id === productId);
    if (!product) throw new AppError("NOT_FOUND", `Product ${productId} not found`);
    if (!product.variants_enabled) return delay(product, 40);

    const mine = this.state.variants.filter((v) => v.product_id === productId);
    const references = demoVariantReferences();
    const referenced = mine.filter((v) => (references[v.id] ?? 0) > 0);
    if (referenced.length > 0) {
      throw new AppError(
        "VARIANTS_IN_USE",
        `${product.sku} has variants named by history (${referenced
          .map((v) => v.sku)
          .join(", ")}); it stays in variant mode`,
      );
    }
    if (!product.stock_tracking_enabled) {
      return this.patchProduct(productId, { variants_enabled: false });
    }
    const total = mine.reduce((sum, v) => sum + v.stock_quantity, 0);
    if (Math.trunc(consolidatedStock) !== total) {
      throw new AppError(
        "VARIANTS_STOCK_MISMATCH",
        `The consolidated figure is ${Math.trunc(consolidatedStock)} but the variants hold ${total}`,
      );
    }
    this.state.variants = this.state.variants.filter((v) => v.product_id !== productId);
    this.state.color_images = this.state.color_images.filter((image) => image.product_id !== productId);
    return this.patchProduct(productId, { variants_enabled: false, stock_quantity: total });
  }

  /** The variant row a barcode/SKU belongs to, or null. Exact, never a guess. */
  findVariantByCode(code: string): ProductVariant | null {
    const wanted = code.trim().toUpperCase();
    if (!wanted) return null;
    return (
      this.state.variants.find(
        (v) => v.sku.toUpperCase() === wanted || (v.barcode ?? "").toUpperCase() === wanted,
      ) ?? null
    );
  }

  /** The exact combination's stock, or the product rollup when it has none. */
  availableStock(productId: string, variantId?: string | null): number {
    if (variantId) {
      const variant = this.state.variants.find((v) => v.id === variantId);
      if (!variant) throw new AppError("VARIANT_NOT_FOUND", `Variant ${variantId} not found`);
      return variant.stock_quantity;
    }
    const product = this.state.products.find((p) => p.id === productId);
    if (!product) throw new AppError("NOT_FOUND", `Product ${productId} not found`);
    return product.stock_quantity;
  }

  /**
   * Move one combination's stock by `delta` (negative to sell), exactly like the
   * live table does. The product rollup follows, and the caller is responsible
   * for the movement row that explains it.
   */
  moveVariantStock(variantId: string, delta: number): ProductVariant {
    const index = this.state.variants.findIndex((v) => v.id === variantId);
    if (index === -1) throw new AppError("VARIANT_NOT_FOUND", `Variant ${variantId} not found`);
    const current = this.state.variants[index];
    const next = Math.max(0, current.stock_quantity + Math.trunc(delta));
    const updated = [...this.state.variants];
    updated[index] = { ...current, stock_quantity: next, updated_at: nowIso() };
    this.state.variants = updated;
    this.syncProductRollup(current.product_id);
    this.persist();
    return updated[index];
  }

  /** Σ variant stock written onto the product row — the one derived number. */
  private syncProductRollup(productId: string): void {
    const product = this.state.products.find((p) => p.id === productId);
    if (!product) return;
    // The rollup follows the variants only once the product sells by variant.
    // Before the conversion the product's own figure is the truth and a drafted
    // combination (which starts empty) must not zero it — the conversion funnel
    // then distributes that figure across the shelves. Mirrors the guard in
    // `variants_sync_product_stock` (0043).
    if (!product.variants_enabled) return;
    const total = this.state.variants
      .filter((v) => v.product_id === productId)
      .reduce((sum, v) => sum + v.stock_quantity, 0);
    if (product.stock_quantity === total) return;
    this.patchProduct(productId, { stock_quantity: total });
  }

  /**
   * Write to a product row without the guards `updateProduct` carries — the
   * internal writer used by the rollup and by the two conversion functions,
   * which are the only code allowed to move `stock_quantity` on a variant
   * product (correction 6).
   */
  private patchProduct(productId: string, patch: ProductPatch): Product {
    const index = this.state.products.findIndex((p) => p.id === productId);
    if (index === -1) throw new AppError("NOT_FOUND", `Product ${productId} not found`);
    const next: Product = { ...this.state.products[index], ...patch, updated_at: nowIso() };
    const updated = [...this.state.products];
    updated[index] = next;
    this.state.products = updated;
    this.persist();
    return next;
  }

  private assertUniqueVariantCode(field: "sku" | "barcode", value: string, excludeId?: string): void {
    const wanted = value.toUpperCase();
    const clash = this.state.variants.find(
      (v) =>
        v.id !== excludeId &&
        ((field === "sku" ? v.sku.toUpperCase() : (v.barcode ?? "").toUpperCase()) === wanted),
    );
    if (clash) {
      throw new AppError(
        field === "sku" ? "DUPLICATE_SKU" : "DUPLICATE_BARCODE",
        `${field === "sku" ? "SKU" : "Barcode"} ${value} already belongs to variant ${clash.sku} of another combination`,
        field,
        "23505",
      );
    }
    // A variant's own code must not collide with a PRODUCT's either: a scan
    // resolves one exact row, so two rows answering to one code is a bug the
    // database refuses (shared `catalogue_codes` registry) and so does this.
    const productClash = this.state.products.find(
      (p) =>
        (field === "sku" ? p.sku.toUpperCase() === wanted : (p.barcode ?? "").toUpperCase() === wanted) &&
        wanted !== "",
    );
    if (productClash) {
      throw new AppError(
        field === "sku" ? "DUPLICATE_SKU" : "DUPLICATE_BARCODE",
        `${field === "sku" ? "SKU" : "Barcode"} ${value} already identifies product ${productClash.sku}`,
        field,
        "23505",
      );
    }
  }

  /** The exact combination — colour identity + numeric size — may exist once. */
  private assertVariantIdentityFree(variant: ProductVariant, excludeId?: string): void {
    const clash = this.state.variants.find(
      (v) =>
        v.id !== excludeId &&
        v.product_id === variant.product_id &&
        v.color_key === variant.color_key &&
        variantSizeValue(v).toLocaleLowerCase() === variantSizeValue(variant).toLocaleLowerCase(),
    );
    if (clash) {
      throw new AppError(
        "VALIDATION",
        `${variantLabel(variant)} already exists for this product — a combination is unique`,
        "size",
        "23505",
      );
    }
  }

  // ── categories ─────────────────────────────────────────────────────────
  // The demo mirrors migration 0044 rule for rule: same refusals, same
  // AppError codes, same pgCode strings — so a test that passes here states
  // the live contract too.

  listCategories(): Promise<Category[]> {
    return delay([...this.state.categories]);
  }

  async createCategory(input: NewCategory): Promise<Category> {
    const category: Category = { ...input, id: this.newId("cat"), ...timestamps() };
    this.state.categories = [...this.state.categories, category];
    this.persist();
    return delay(category, 60);
  }

  async updateCategory(id: string, patch: CategoryPatch): Promise<Category> {
    const index = this.state.categories.findIndex((c) => c.id === id);
    if (index === -1) throw new AppError("NOT_FOUND");
    const current = this.state.categories[index];
    const next: Category = { ...current, ...patch, updated_at: nowIso() };
    const updated = [...this.state.categories];
    updated[index] = next;
    this.state.categories = updated;
    this.persist();
    return delay(next, 60);
  }

  /**
   * Mirrors `products_enforce_category_active` (0044): a product may never be
   * assigned to an archived category — not from the form, not from a forged
   * call, not from an import. `context` only flavours the message.
   */
  private assertCategoryAssignable(categoryId: string | null | undefined, context: string): void {
    if (!categoryId) return;
    const category = this.state.categories.find((c) => c.id === categoryId);
    if (category && !category.active) {
      throw new AppError(
        "CATEGORY_ARCHIVED",
        `Category ${category.name_en} is archived — a product cannot be assigned to it (${context})`,
        "category_id",
        "23514",
      );
    }
  }

  async deleteCategory(id: string): Promise<void> {
    // The demo delete mirrors delete_empty_category: re-check products and
    // children at the moment of deletion, refuse with the structured code.
    const category = this.state.categories.find((c) => c.id === id);
    if (!category) throw new AppError("NOT_FOUND", `Category ${id} not found`, undefined, "23503");
    const productCount = this.state.products.filter((p) => p.category_id === id).length;
    if (productCount > 0) {
      throw new AppError(
        "CATEGORY_NOT_EMPTY",
        `Category ${category.name_en} still contains ${productCount} product(s)`,
        undefined,
        "23514",
      );
    }
    const childCount = this.state.categories.filter((c) => c.parent_id === id).length;
    if (childCount > 0) {
      throw new AppError(
        "CATEGORY_HAS_CHILDREN",
        `Category ${category.name_en} still contains ${childCount} child categor(y/ies); move or delete them first`,
        undefined,
        "23001",
      );
    }
    this.state.categories = this.state.categories.filter((c) => c.id !== id);
    this.persist();
    await delay(undefined, 60);
  }

  async setCategoryActive(id: string, active: boolean): Promise<Category> {
    const index = this.state.categories.findIndex((c) => c.id === id);
    if (index === -1) throw new AppError("NOT_FOUND", `Category ${id} not found`, undefined, "23503");
    const current = this.state.categories[index];
    // Idempotent like set_category_active: no change, no event.
    if (current.active === active) return delay(current, 30);
    const next: Category = { ...current, active, updated_at: nowIso() };
    const updated = [...this.state.categories];
    updated[index] = next;
    this.state.categories = updated;
    this.persist();
    return delay(next, 60);
  }

  async moveProductsAndDeleteCategory(
    sourceId: string,
    targetId: string,
  ): Promise<{ moved: number; source: Category; target: Category }> {
    if (sourceId === targetId) {
      throw new AppError(
        "VALIDATION",
        "Source and target are the same category",
        undefined,
        "23514",
      );
    }
    const source = this.state.categories.find((c) => c.id === sourceId);
    if (!source) {
      throw new AppError("NOT_FOUND", `Source category ${sourceId} not found`, undefined, "23503");
    }
    const target = this.state.categories.find((c) => c.id === targetId);
    if (!target) {
      throw new AppError("NOT_FOUND", `Target category ${targetId} not found`, undefined, "23503");
    }
    if (!target.active) {
      throw new AppError(
        "CATEGORY_ARCHIVED",
        `Target category ${target.name_en} is archived — products cannot move into it`,
        undefined,
        "23514",
      );
    }
    const childCount = this.state.categories.filter((c) => c.parent_id === sourceId).length;
    if (childCount > 0) {
      throw new AppError(
        "CATEGORY_HAS_CHILDREN",
        `Source category ${source.name_en} still contains ${childCount} child categor(y/ies); move or delete them first`,
        undefined,
        "23001",
      );
    }

    // One atomic step: move, verify zero remaining, delete. Demo state is
    // single-threaded, so the window the live RPC closes with row locks does
    // not exist here — the verification still runs, mirroring the server.
    const movedIds: string[] = [];
    const products = this.state.products.map((p) => {
      if (p.category_id !== sourceId) return p;
      movedIds.push(p.id);
      return { ...p, category_id: targetId, updated_at: nowIso() };
    });
    const remaining = products.filter((p) => p.category_id === sourceId).length;
    if (remaining > 0) {
      throw new AppError(
        "CATEGORY_NOT_EMPTY",
        `Category ${source.name_en} still holds ${remaining} product(s) after the move`,
        undefined,
        "23514",
      );
    }
    this.state.products = products;
    this.state.categories = this.state.categories.filter((c) => c.id !== sourceId);
    this.persist();
    await delay(undefined, 60);
    return { moved: movedIds.length, source, target };
  }

  /** Test/dev helper used by the module reset button. */
  reset(): void {
    this.state = {
      categories: buildDemoCategories(),
      products: buildDemoProducts(),
      variants: [],
      color_images: [],
      seed_revision: SEED_REVISION,
    };
    this.persist();
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private assertUniqueSku(sku: string, excludeId?: string): void {
    const clash = this.state.products.find(
      (p) => p.sku.toLowerCase() === sku.trim().toLowerCase() && p.id !== excludeId,
    );
    if (clash) throw new AppError("DUPLICATE_SKU", `SKU ${sku} already exists`, "sku", "23505");
  }

  private assertUniqueBarcode(barcode: string, excludeId?: string): void {
    const clash = this.state.products.find(
      (p) => p.barcode && p.barcode === barcode && p.id !== excludeId,
    );
    if (clash) {
      throw new AppError("DUPLICATE_BARCODE", `Barcode ${barcode} already exists`, "barcode", "23505");
    }
  }

  private newId(prefix: string): string {
    const rand =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(16).slice(2) + Date.now().toString(16);
    return `${prefix}-${rand}`;
  }
}

/** Colour identity, then NUMERIC size — never a string sort. */
function compareVariantRows(a: ProductVariant, b: ProductVariant): number {
  if (a.product_id !== b.product_id) return a.product_id.localeCompare(b.product_id);
  return compareVariants(a,b);
}

function timestamps(): { created_at: string; updated_at: string } {
  const now = nowIso();
  return { created_at: now, updated_at: now };
}

let singleton: DemoRepository | null = null;

export function getDemoRepository(): DemoRepository {
  if (!singleton) singleton = new DemoRepository();
  return singleton;
}
