import assert from "node:assert/strict";
import fs from "node:fs";
import type { ALYQDesktopApi, DesktopConfig } from "@/lib/desktop/types";
import type { Sale } from "../types";
import { autoPrintReceiptDocument, openDrawerAfterCashSale, printReceiptDocument } from "../services/hardware";
import { buildReceiptHtml, type ReceiptStrings } from "../services/receipt";

const baseConfig: DesktopConfig = {
  schemaVersion: 1,
  installationId: "423e4567-e89b-42d3-a456-426614174003",
  registerBinding: null,
  hardware: { printerName: "Thermal", paperWidthMm: 80, copies: 1, silentPrint: true, autoPrintAfterSale: false, drawerMode: "printer-driver", autoOpenCashDrawer: true },
};
let config = structuredClone(baseConfig);
let drawerCalls = 0;
let printCalls = 0;
const api = {
  getConfig: async () => config,
  kickDrawer: async () => { drawerCalls += 1; return { submitted: true, confirmedPrinted: false, printerName: "Thermal", paperWidthMm: 80, reference: "x", purpose: "drawer", drawerState: "unknown" }; },
  printReceipt: async () => { printCalls += 1; return { submitted: true, confirmedPrinted: false, printerName: "Thermal", paperWidthMm: 80, reference: "x", purpose: "receipt" }; },
} as unknown as ALYQDesktopApi;
(globalThis as unknown as { window: { alyqDesktop: ALYQDesktopApi } }).window = { alyqDesktop: api };

function sale(method: "cash" | "visa", ref: string): Sale {
  return {
    id: ref, sale_number: ref, client_ref: ref, status: "completed", subtotal: 100,
    discount_type: "none", discount_value: 0, discount_amount: 0, total: 100,
    user_id: "u", user_name: "Cashier", branch_id: "b", branch_name: "Main Branch", register_id: "r", register_name: "Front Till",
    items: [{ id: "i", sale_id: ref, product_id: "p", variant_id: "v", variant_color_ar: "أسود", variant_color_en: "Black", variant_size: 42, variant_size_label: "42", name_ar: "منتج", name_en: "Product", sku: "ALYQ-01-BLK-42", barcode: "629ALYQ0142", unit_price: 100, quantity: 1, line_total: 100 }],
    payments: [{ id: "pay", sale_id: ref, method, amount: 100, status: "paid", paid_at: null, paid_by: null, paid_by_name: null }],
    created_at: "2026-10-03T10:00:00Z", voided_at: null, void_reason: null,
    payment_method: method, payment_status: "paid", amount_received: method === "cash" ? 100 : null,
    change: method === "cash" ? 0 : null, paid_at: null, paid_by: null, paid_by_name: null,
  } as Sale;
}
const strings = {
  businessName: "ALYQ", saleLabel: "Sale", dateLabel: "Date", cashierLabel: "Cashier", branchLabel: "Branch", registerLabel: "Register",
  itemLabel: "Item", qtyLabel: "Qty", priceLabel: "Price", totalLabel: "Total", subtotalLabel: "Subtotal",
  discountLabel: "Discount", paymentLabel: "Payment", receivedLabel: "Received", changeLabel: "Change",
  paidLabel: "Paid", remainingLabel: "Remaining", customerLabel: "Customer", customerPhoneLabel: "Phone",
  statusLabel: "Status", thankYou: "Thanks", voidedNotice: "Voided",
} satisfies ReceiptStrings;

const tests: Array<[string, () => Promise<void> | void]> = [
  ["historical receipt renders frozen register and exact Black/42 evidence", () => {
    const html = buildReceiptHtml({ sale: sale("cash", "INV-1"), strings, direction: "ltr" });
    assert.match(html, /Front Till/); assert.match(html, /Black \/ 42/); assert.match(html, /ALYQ-01-BLK-42/); assert.match(html, /629ALYQ0142/);
  }],
  ["Arabic/English, XL, discounts and split cash/card evidence render from history", () => {
    const historical = sale("cash", "INV-MIXED");
    historical.items.push({ ...historical.items[0]!, id: "i-xl", variant_id: "v-xl", variant_color_ar: "أزرق", variant_color_en: "Blue", variant_size: null, variant_size_label: "XL", name_ar: "قميص", name_en: "Shirt", sku: "ALYQ-02-BLU-XL", barcode: "629ALYQ02XL" });
    historical.subtotal = 215; historical.discount_type = "fixed"; historical.discount_value = 15; historical.discount_amount = 15; historical.total = 200;
    historical.payments = [
      { ...historical.payments[0]!, id: "cash", method: "cash", amount: 80 },
      { ...historical.payments[0]!, id: "visa", method: "visa", amount: 120 },
    ];
    const html = buildReceiptHtml({ sale: historical, strings: { ...strings, itemLabel: "الصنف / Item", discountLabel: "الخصم / Discount" }, direction: "rtl" });
    assert.match(html, /dir="rtl"/); assert.match(html, /Main Branch/); assert.match(html, /أزرق \/ XL/); assert.match(html, /ALYQ-02-BLU-XL/);
    assert.match(html, /الخصم \/ Discount/); assert.match(html, /Cash/); assert.match(html, /Visa/); assert.match(html, /80\.00/); assert.match(html, /120\.00/);
  }],
  ["80mm and 58mm are the only bounded main-process layouts", () => {
    const source = fs.readFileSync("desktop/main.mjs", "utf8");
    const contracts = fs.readFileSync("desktop/contracts.mjs", "utf8");
    assert.match(contracts, /\[58, 80\]/); assert.match(source, /paperWidthMm \* 1000/); assert.match(source, /printableWidth/); assert.match(source, /copies: purpose === "receipt"/);
  }],
  ["non-cash payment never opens the drawer", async () => {
    assert.equal(await openDrawerAfterCashSale(sale("visa", "VISA-1")), "skipped"); assert.equal(drawerCalls, 0);
  }],
  ["completed cash sale submits one drawer job and never duplicates it", async () => {
    assert.equal(await openDrawerAfterCashSale(sale("cash", "CASH-1")), "submitted");
    assert.equal(await openDrawerAfterCashSale(sale("cash", "CASH-1")), "skipped"); assert.equal(drawerCalls, 1);
  }],
  ["disabled auto-open rule blocks drawer submission", async () => {
    config = { ...baseConfig, hardware: { ...baseConfig.hardware, autoOpenCashDrawer: false } };
    assert.equal(await openDrawerAfterCashSale(sale("cash", "CASH-2")), "skipped"); assert.equal(drawerCalls, 1);
    config = structuredClone(baseConfig);
  }],
  ["configured auto-print makes one spool attempt per completed sale", async () => {
    config = { ...baseConfig, hardware: { ...baseConfig.hardware, copies: 2, autoPrintAfterSale: true } };
    const html = "<!doctype html><html><head></head><body>receipt</body></html>";
    assert.equal(await autoPrintReceiptDocument(html, "AUTO-1"), "submitted");
    assert.equal(await autoPrintReceiptDocument(html, "AUTO-1"), "skipped");
    assert.equal(printCalls, 1); config = structuredClone(baseConfig);
  }],
  ["native receipt submission is separate from transaction state", async () => {
    const before = sale("cash", "CASH-3"); const snapshot = JSON.stringify(before);
    assert.equal(await printReceiptDocument("<!doctype html><html><head></head><body>receipt</body></html>", before.sale_number), "submitted");
    assert.equal(printCalls, 2); assert.equal(JSON.stringify(before), snapshot);
  }],
];

for (const [name, run] of tests) { await run(); console.log(`  ✓ ${name}`); }
console.log(`\n${tests.length}/${tests.length} desktop hardware/receipt tests passed`);
