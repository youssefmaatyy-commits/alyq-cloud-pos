import type { Product, ProductPatch } from "@/modules/products/types";
import { AppError } from "@/modules/products/data/repository";
import { buildDemoCategories, buildDemoProducts, safeStorage } from "@/modules/products/data/demoSeed";
import { getDemoRepository as getCatalogDemo } from "@/modules/products/data/demoRepository";
import type { NewStockMovement, StockMovement } from "../types";
import { signedDelta } from "../types";
import type { AdjustStockArgs, InventoryRepository } from "./repository";

const MOVEMENT_KEY = "alyq.demo.stock_movements.v1";
const LATENCY = 90;

function nowIso(): string {
  return new Date().toISOString();
}

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function persist(movements: StockMovement[]): void {
  safeStorage.set(MOVEMENT_KEY, JSON.stringify(movements));
}

function load(): StockMovement[] {
  const raw = safeStorage.get(MOVEMENT_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as StockMovement[];
  } catch {
    return [];
  }
}

function newId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 13)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${prefix}-${rand}`;
}

/**
 * Demo implementation of the inventory persistence contract.
 * Stock state lives on the existing demo `Product` rows; movements are kept
 * in their own localStorage bucket so a products reset doesn't orphan the
 * movement history.
 */
export class DemoInventoryRepository implements InventoryRepository {
  readonly kind = "demo" as const;

  private movements: StockMovement[];

  constructor() {
    this.movements = load();
  }

  async listProducts(): Promise<Product[]> {
    return getCatalogDemo().listProducts();
  }

  async updateProductStock(productId: string, patch: ProductPatch): Promise<Product> {
    return getCatalogDemo().updateProduct(productId, patch);
  }

  async listMovements(): Promise<StockMovement[]> {
    return delay([...this.movements].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }

  async listMovementsForProduct(productId: string): Promise<StockMovement[]> {
    return delay(
      this.movements
        .filter((m) => m.product_id === productId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    );
  }

  async recordMovement(input: NewStockMovement): Promise<StockMovement> {
    const movement: StockMovement = {
      ...input,
      id: newId("mov"),
      created_at: nowIso(),
      quantity_before: 0,
      quantity_after: 0,
    };
    this.movements = [movement, ...this.movements];
    persist(this.movements);
    return delay(movement, 40);
  }

  /**
   * Append an already-snapshotted movement, keeping the in-memory cache and
   * localStorage in sync.
   *
   * Without this, a caller that persists directly would leave `this.movements`
   * stale: subsequent reads miss the new row, and the *next* write — which
   * rebuilds the list from the stale cache — silently drops it from the
   * ledger. Both are unacceptable for an append-only audit trail.
   */
  appendMovement(movement: StockMovement): StockMovement {
    this.movements = [movement, ...this.movements];
    persist(this.movements);
    return movement;
  }

  /** Test/dev helper used by the reset button. */
  reset(): void {
    this.movements = [];
    persist(this.movements);
  }
}

let singleton: DemoInventoryRepository | null = null;

export function getDemoInventoryRepository(): DemoInventoryRepository {
  if (!singleton) singleton = new DemoInventoryRepository();
  return singleton;
}

/**
 * Apply a stock adjustment atomically: the new movement is recorded first,
 * then the product is updated and the movement is enriched with the
 * `quantity_before` / `quantity_after` snapshot. Callers are responsible for
 * validation; this function assumes the inputs are already safe.
 */
export async function applyDemoAdjustment(
  args: AdjustStockArgs,
  products: Product[],
  repo = getDemoInventoryRepository(),
): Promise<{ product: Product; movement: StockMovement }> {
  const index = products.findIndex((p) => p.id === args.productId);
  if (index === -1) throw new AppError("NOT_FOUND");
  const current = products[index];
  if (!current.stock_tracking_enabled) {
    throw new AppError("VALIDATION", "Stock tracking is disabled for this product", "quantity");
  }
  const quantityBefore = current.stock_quantity;
  const newQty = Math.max(0, quantityBefore + signedDelta(args.type, args.quantity));
  // Pre-compute the snapshot so the movement is durable in one read.
  const movement: StockMovement = {
    id: newId("mov"),
    product_id: current.id,
    delta: args.quantity,
    type: args.type,
    reason: args.reason,
    notes: args.notes,
    user_id: args.userId,
    user_name: args.userName,
    quantity_before: quantityBefore,
    quantity_after: newQty,
    created_at: nowIso(),
  };
  // Append through the repository so the in-memory cache and storage stay in
  // sync (a direct `persist` here would strand the cache and lose rows).
  repo.appendMovement(movement);
  const product = await repo.updateProductStock(current.id, { stock_quantity: newQty });
  return { product, movement };
}

// keep buildDemo* referenced so the seed module is treated as a side-effect dep
void buildDemoCategories;
void buildDemoProducts;