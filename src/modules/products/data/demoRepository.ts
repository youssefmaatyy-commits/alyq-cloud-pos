import type {
  Category,
  CategoryPatch,
  NewCategory,
  NewProduct,
  Product,
  ProductPatch,
} from "../types";
import { AppError, type CatalogRepository } from "./repository";
import { buildDemoCategories, buildDemoProducts, safeStorage } from "./demoSeed";

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
const SEED_REVISION = 2;

interface DemoState {
  categories: Category[];
  products: Product[];
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
          return parsed;
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
    const product: Product = { ...input, id: this.newId("prd"), ...timestamps() };
    this.state.products = [product, ...this.state.products];
    this.persist();
    return delay(product, 60);
  }

  async updateProduct(id: string, patch: ProductPatch): Promise<Product> {
    const index = this.state.products.findIndex((p) => p.id === id);
    if (index === -1) throw new AppError("NOT_FOUND");
    const next: Product = { ...this.state.products[index], ...patch };
    if (patch.sku !== undefined) {
      this.assertUniqueSku(patch.sku, id);
    }
    if (patch.barcode) {
      this.assertUniqueBarcode(patch.barcode, id);
    }
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

  // ── categories ─────────────────────────────────────────────────────────

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

  async deleteCategory(id: string): Promise<void> {
    const inUse = this.state.products.some((p) => p.category_id === id);
    if (inUse) throw new AppError("CATEGORY_IN_USE");
    this.state.categories = this.state.categories.filter((c) => c.id !== id);
    this.persist();
    await delay(undefined, 60);
  }

  /** Test/dev helper used by the module reset button. */
  reset(): void {
    this.state = {
      categories: buildDemoCategories(),
      products: buildDemoProducts(),
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

function timestamps(): { created_at: string; updated_at: string } {
  const now = nowIso();
  return { created_at: now, updated_at: now };
}

let singleton: DemoRepository | null = null;

export function getDemoRepository(): DemoRepository {
  if (!singleton) singleton = new DemoRepository();
  return singleton;
}
