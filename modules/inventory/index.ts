/**
 * Inventory module (Phase 3) public surface.
 * The phase 2 catalog (`@/modules/products`) is the source of truth for
 * products + categories; this module only owns the movement ledger and the
 * stock-adjustment workflow.
 */
export { InventoryProvider, useInventory } from "./hooks/InventoryProvider";
export { InventoryPage } from "./pages/InventoryPage";
export { MovementsPage } from "./pages/MovementsPage";
export { StockStatusBadge } from "./components/StockStatusBadge";
export { StockAdjustmentModal } from "./components/StockAdjustmentModal";
export {
  STOCK_MOVEMENT_TYPES,
  STOCK_REASONS,
  applyStockDelta,
  isOutbound,
  signedDelta,
  directionLabel,
  EMPTY_ADJUSTMENT_FORM,
} from "./types";
export type {
  StockMovement,
  StockMovementType,
  StockReason,
  NewStockMovement,
  StockAdjustmentFormValues,
} from "./types";
export {
  adjustStock,
  loadInventory,
} from "./services/inventoryService";
export {
  queryInventory,
  summarizeInventory,
  paginate,
  totalPagesFor,
  EMPTY_INVENTORY_FILTERS,
} from "./services/inventoryQuery";
export type { InventoryFiltersValue } from "./services/inventoryQuery";
export {
  validateAdjustment,
  parseAdjustmentQuantity,
  ADJUSTMENT_ERROR_KEY,
  MAX_ADJUSTMENT_NOTES,
} from "./validation";
export type {
  AdjustmentErrors,
  AdjustmentFieldCode,
  AdjustmentValidationResult,
} from "./validation";
export {
  canAdjustStock,
  canViewInventory,
  getCurrentUser,
  setCurrentUser,
  ALL_ROLES,
  ROLE_LABEL,
  INVENTORY_ROLES,
} from "./permissions";
export type { InventoryRole, InventoryUser } from "./permissions";
export {
  getInventoryRepository,
  getInventoryMode,
  applyDemoAdjustment,
  applySupabaseAdjustment,
} from "./data";
export { DemoInventoryRepository, SupabaseInventoryRepository } from "./data";
export type { InventoryRepository, AdjustStockArgs } from "./data/repository";
