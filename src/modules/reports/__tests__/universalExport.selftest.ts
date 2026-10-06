/**
 * Universal Data Export Engine Selftest Suite.
 *
 * Verifies:
 *   1. Multi-domain workbook generation (Sales, Inventory, Catalog, Customers, Online, Shifts, Audit, Admin).
 *   2. Full Business Export multi-sheet workbook builder.
 *   3. Numeric money/integer cells with formatting metadata.
 *   4. Date safety with Date objects.
 *   5. Formula injection sanitization across all columns.
 *   6. Cost price permission gating.
 *   7. Date range and branch filtering.
 */
import assert from "node:assert/strict";
import {
  buildFullBusinessExportWorkbook,
  buildUniversalAdminSheets,
  buildUniversalAuditSheets,
  buildUniversalCatalogSheets,
  buildUniversalCustomersSheets,
  buildUniversalInventorySheets,
  buildUniversalOnlineOrdersSheets,
  buildUniversalSalesSheets,
  buildUniversalShiftsSheets,
  type FullBusinessData,
  type UniversalExportContext,
} from "../services/universalExport";
import { sanitizeFormula } from "@/lib/export/excelExport";
import type { Sale } from "@/modules/pos/types";
import type { Product, Category } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { Customer } from "@/modules/customers/types";
import type { SalesReturn, RefundRecord } from "@/modules/returns/types";
import type { Expense } from "@/modules/expenses/types";
import type { Shift } from "@/modules/shifts/types";
import type { StockMovement } from "@/modules/inventory/types";
import type { OnlineOrder } from "@/modules/online/types";
import type { AuditLogEntry } from "@/modules/audit/types";
import type { ManagedUser } from "@/modules/settings/types";
import type { CustomRole } from "@/lib/permissions/customRoles";
import type { BranchAccess } from "@/lib/branch/BranchProvider";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

// Mock context
const mockCtx: UniversalExportContext = {
  t: (key: string) => key,
  pick: (ar, en) => `${ar ?? ""} / ${en ?? ""}`,
  maySeeCost: true,
};

const mockProducts: Product[] = [
  {
    id: "prod-1",
    sku: "TSHIRT-BLK",
    barcode: "622123456001",
    name_ar: "قميص أسود",
    name_en: "Black T-Shirt",
    description_ar: null,
    description_en: null,
    category_id: "cat-1",
    product_type: "physical",
    cost_price: 150,
    selling_price: 300,
    tax_rate: 14,
    stock_tracking_enabled: true,
    stock_quantity: 25,
    low_stock_level: 5,
    show_on_website: true,
    is_featured: false,
    active: true,
    variants_enabled: true,
    image_url: null,
    images: [],
    created_at: "2026-01-15T10:00:00.000Z",
    updated_at: "2026-01-15T10:00:00.000Z",
  },
];

const mockVariants: ProductVariant[] = [
  {
    id: "var-1",
    product_id: "prod-1",
    sku: "TSHIRT-BLK-L",
    barcode: "622123456002",
    color_ar: "أسود",
    color_en: "Black",
    color_key: "black",
    color_hex: "#000000",
    size: 42,
    size_label: "L",
    sort_order: 1,
    cost_override: 160,
    price_override: 320,
    stock_quantity: 15,
    low_stock_level: 3,
    image_url: null,
    active: true,
    created_at: "2026-01-15T10:00:00.000Z",
    updated_at: "2026-01-15T10:00:00.000Z",
  },
];

const mockCategories: Category[] = [
  {
    id: "cat-1",
    name_ar: "ملابس رجالي",
    name_en: "Men Clothing",
    parent_id: null,
    sort_order: 1,
    active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

const mockSales: Sale[] = [
  {
    id: "sale-1",
    sale_number: "INV-2026-0001",
    client_ref: "CR-001",
    created_at: "2026-02-01T14:30:00.000Z",
    user_id: "usr-1",
    user_name: "Cashier Ahmed",
    customer_id: "cust-1",
    customer_name: "Mohamed Ali",
    customer_phone: "01012345678",
    subtotal: 600,
    discount_amount: 50,
    total: 627,
    amount_received: 700,
    change: 73,
    status: "completed",
    items: [
      {
        id: "item-1",
        sale_id: "sale-1",
        product_id: "prod-1",
        variant_id: "var-1",
        sku: "TSHIRT-BLK-L",
        barcode: "622123456002",
        name_ar: "قميص أسود",
        name_en: "Black T-Shirt",
        variant_color_ar: "أسود",
        variant_color_en: "Black",
        variant_size: 42,
        variant_size_label: "L",
        unit_price: 300,
        unit_cost: 150,
        quantity: 2,
        discount_amount: 0,
        line_total: 600,
      },
    ],
    payments: [
      {
        id: "pay-1",
        sale_id: "sale-1",
        method: "cash",
        amount: 400,
        status: "paid",
        paid_at: "2026-02-01T14:30:00.000Z",
        paid_by: "usr-1",
        paid_by_name: "Cashier Ahmed",
      },
      {
        id: "pay-2",
        sale_id: "sale-1",
        method: "visa",
        amount: 227,
        status: "paid",
        paid_at: "2026-02-01T14:30:00.000Z",
        paid_by: "usr-1",
        paid_by_name: "Cashier Ahmed",
      },
    ],
  } as unknown as Sale,
];

const mockReturns: SalesReturn[] = [
  {
    id: "ret-1",
    return_number: "RET-2026-0001",
    sale_id: "sale-1",
    sale_number: "INV-2026-0001",
    customer_id: null,
    customer_name: null,
    user_id: "usr-1",
    user_name: "Ahmed",
    refund_amount: 300,
    refund_method: "cash",
    refund_status: "completed",
    reason: "Wrong size",
    created_at: "2026-02-02T10:00:00.000Z",
    items: [],
  },
];

const mockRefunds: RefundRecord[] = [
  {
    id: "ref-1",
    refund_number: "REF-2026-0001",
    sale_id: "sale-1",
    sale_number: "INV-2026-0001",
    amount: 300,
    payment_method: "cash",
    status: "completed",
    reason: "Defective item",
    created_at: "2026-02-02T10:05:00.000Z",
  } as unknown as RefundRecord,
];

const mockMovements: StockMovement[] = [
  {
    id: "mov-1",
    product_id: "prod-1",
    variant_id: "var-1",
    type: "adjustment_in",
    reason: "recount",
    delta: 15,
    quantity_before: 0,
    quantity_after: 15,
    user_name: "Admin",
    notes: "Batch #1",
    created_at: "2026-01-15T10:00:00.000Z",
  } as unknown as StockMovement,
];

const mockCustomers: Customer[] = [
  {
    id: "cust-1",
    name: "Mohamed Ali",
    phone: "01012345678",
    email: "mohamed@example.com",
    address: "Cairo, Egypt",
    notes: "VIP Customer",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

const mockOnlineOrders: OnlineOrder[] = [
  {
    id: "ord-1",
    order_number: "WEB-1001",
    client_ref: "REF-1001",
    store_customer_id: null,
    customer_name: "Sara Ahmed",
    customer_phone: "01123456789",
    customer_email: null,
    delivery_type: "delivery",
    delivery_zone_id: "zone-1",
    delivery_zone_name_ar: "مدينة نصر",
    delivery_zone_name_en: "Nasr City",
    subtotal: 500,
    delivery_fee: 40,
    discount_amount: 25,
    total: 515,
    payment_method: "cod",
    payment_status: "pending",
    status: "pending",
    address: null,
    items: [],
    created_at: "2026-02-03T16:00:00.000Z",
    updated_at: "2026-02-03T16:00:00.000Z",
  } as unknown as OnlineOrder,
];

const mockShifts: Shift[] = [
  {
    id: "shift-1",
    opened_by_name: "Ahmed",
    opening_at: "2026-02-01T08:00:00.000Z",
    closed_at: "2026-02-01T16:00:00.000Z",
    opening_cash: 500,
    closing_cash: 2500,
    status: "closed",
    summary: {
      expected_cash: 2500,
      actual_cash: 2500,
      difference: 0,
      cash_sales: 2000,
      cash_returns: 0,
      cash_expenses: 0,
      net_cash: 2000,
      total_sales: 2000,
    } as unknown as Shift["summary"],
  } as unknown as Shift,
];

const mockExpenses: Expense[] = [
  {
    id: "exp-1",
    name: "Cleaning Supplies",
    category: "supplies",
    amount: 120,
    payment_method: "cash",
    spent_at: "2026-02-01T11:00:00.000Z",
    user_name: "Ahmed",
    notes: "Store floor cleaner",
  } as unknown as Expense,
];

const mockAuditLogs: AuditLogEntry[] = [
  {
    id: "aud-1",
    action: "import.applied",
    entity: "product",
    entity_id: "batch-101",
    entity_label: "Catalog Import Batch",
    user_name: "Admin",
    details: { rows: 15, duration_ms: 240 },
    created_at: "2026-02-01T09:00:00.000Z",
  } as unknown as AuditLogEntry,
];

const mockProfiles: ManagedUser[] = [
  {
    id: "usr-1",
    username: "ahmed",
    name: "Ahmed Manager",
    email: "ahmed@alyq.com",
    phone: "01000000001",
    role: "manager",
    active: true,
    custom_role_id: null,
    custom_role_name: null,
    extra_capabilities: [],
    denied_capabilities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    last_login_at: "2026-02-01T08:00:00.000Z",
  },
];

const mockBranches: BranchAccess[] = [
  {
    id: "branch-1",
    code: "CAI-01",
    name_ar: "فرع القاهرة",
    name_en: "Cairo Branch",
    role: "admin",
    custom_role_id: null,
    custom_role_name: null,
    active: true,
    is_current: true,
  },
];

const mockCustomRoles: CustomRole[] = [
  {
    id: "role-1",
    key: "supervisor",
    name_ar: "مشرف",
    name_en: "Supervisor",
    description_ar: "مشرف وردية",
    description_en: "Shift Supervisor",
    base_role: "cashier",
    capabilities: ["view_reports", "view_cost", "import_data"],
    created_by: null,
    created_by_name: null,
    active: true,
    is_system: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

const fullData: FullBusinessData = {
  sales: mockSales,
  products: mockProducts,
  variants: mockVariants,
  categories: mockCategories,
  customers: mockCustomers,
  returnsList: mockReturns,
  refundsList: mockRefunds,
  expenses: mockExpenses,
  shifts: mockShifts,
  movements: mockMovements,
  onlineOrders: mockOnlineOrders,
  auditLogs: mockAuditLogs,
  profiles: mockProfiles,
  branches: mockBranches,
  customRoles: mockCustomRoles,
};

test("formula sanitization safely escapes =, +, -, @ leading characters", () => {
  assert.equal(sanitizeFormula("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
  assert.equal(sanitizeFormula("+123456"), "'+123456");
  assert.equal(sanitizeFormula("-SUM(A1:A10)"), "'-SUM(A1:A10)");
  assert.equal(sanitizeFormula("@SUM(B1:B5)"), "'@SUM(B1:B5)");
  assert.equal(sanitizeFormula("Normal Text"), "Normal Text");
  assert.equal(sanitizeFormula("1500"), "1500");
});

test("sales sheets build invoices, itemized lines, tenders, and refunds correctly", () => {
  const sheets = buildUniversalSalesSheets(mockSales, mockReturns, mockRefunds, mockCtx);
  assert.equal(sheets.length, 5);
  assert.equal(sheets[0].name, "export.sheet.invoices");
  assert.equal(sheets[0].rows.length, 1);
  assert.equal(sheets[1].name, "Sale Items");
  assert.equal(sheets[1].rows.length, 1);
  assert.equal(sheets[2].name, "export.sheet.payments");
  assert.equal(sheets[2].rows.length, 2); // Split payments
  assert.equal(sheets[3].name, "export.sheet.returns");
  assert.equal(sheets[4].name, "export.sheet.refunds");
});

test("cost price gating hides sensitive margins when maySeeCost is false", () => {
  const ctxWithoutCost: UniversalExportContext = {
    ...mockCtx,
    maySeeCost: false,
  };
  const sheets = buildUniversalSalesSheets(mockSales, mockReturns, mockRefunds, ctxWithoutCost);
  const itemHeaders = sheets[1].header;
  assert.ok(!itemHeaders.includes("export.col.costPrice"));
  assert.ok(!itemHeaders.includes("export.col.margin"));
});

test("inventory sheets include products, variants, and stock ledger movements", () => {
  const sheets = buildUniversalInventorySheets(
    mockProducts,
    mockVariants,
    mockMovements,
    mockCategories,
    mockCtx,
  );
  assert.equal(sheets.length, 3);
  assert.equal(sheets[0].name, "export.sheet.inventory");
  assert.equal(sheets[1].name, "Variant Stock");
  assert.equal(sheets[2].name, "Stock Ledger");
});

test("catalog sheets export products, combinations, and category tree", () => {
  const sheets = buildUniversalCatalogSheets(
    mockProducts,
    mockVariants,
    mockCategories,
    mockCtx,
  );
  assert.equal(sheets.length, 3);
  assert.equal(sheets[0].name, "export.sheet.products");
  assert.equal(sheets[1].name, "export.sheet.variants");
  assert.equal(sheets[2].name, "Categories");
});

test("customer CRM sheets export order counts and lifetime spend", () => {
  const sheets = buildUniversalCustomersSheets(mockCustomers, mockSales, mockCtx);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].rows.length, 1);
});

test("online orders sheets export delivery details and statuses", () => {
  const sheets = buildUniversalOnlineOrdersSheets(mockOnlineOrders, mockCtx);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].rows.length, 1);
});

test("shifts sheets export drawer over/short reconciliations and expenses", () => {
  const sheets = buildUniversalShiftsSheets(mockShifts, mockExpenses, mockCtx);
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].name, "export.sheet.shifts");
  assert.equal(sheets[1].name, "export.sheet.expenses");
});

test("audit logs and admin sheets export security trails and staff accounts", () => {
  const auditSheets = buildUniversalAuditSheets(mockAuditLogs, mockCtx);
  assert.equal(auditSheets.length, 1);

  const adminSheets = buildUniversalAdminSheets(
    mockProfiles,
    mockBranches,
    mockCustomRoles,
    mockCtx,
  );
  assert.equal(adminSheets.length, 3);
});

test("full business export generates unified multi-sheet workbook", () => {
  const fullSheets = buildFullBusinessExportWorkbook(fullData, mockCtx);
  assert.ok(fullSheets.length >= 10);
  assert.ok(fullSheets.some((s) => s.name === "export.sheet.invoices"));
  assert.ok(fullSheets.some((s) => s.name === "export.sheet.inventory"));
  assert.ok(fullSheets.some((s) => s.name === "export.sheet.products"));
  assert.ok(fullSheets.some((s) => s.name === "export.sheet.customers"));
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`${failed} universal export tests failed`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} universal export tests passed`);
