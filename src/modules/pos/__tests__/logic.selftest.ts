/**
 * POS logic self-test (headless, Node).
 * Run with:
 *   npx esbuild src/modules/pos/__tests__/logic.selftest.ts \
 *     --bundle --format=esm --platform=node \
 *     --outfile=/tmp/alyq-pos-selftest.mjs && node /tmp/alyq-pos-selftest.mjs
 *
 * Covers cart arithmetic, discount rules, the demo sales repository
 * (completion, stock deduction, movements, oversell/negative guards) and the
 * split-payment model: cash-only, InstaPay-only and mixed Cash + InstaPay.
 */
import assert from "node:assert/strict";
import {
  cartTotals,
  cartSubtotal,
  discountAmount,
  lineTotal,
  cashChange,
  validateDiscount,
  round2,
  sumPayments,
  paymentsRemaining,
  smartPaymentCalc,
  autoBalanceOther,
} from "../services/posMath";
import { getDemoSalesRepository } from "../data/demoRepository";
import { getDemoReturnRepository } from "@/modules/returns/data/demoRepository";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { getDemoInventoryRepository } from "@/modules/inventory/data/demoRepository";
import {
  buildReceiptHtml,
  buildReturnReceiptHtml,
  customerInfoIssue,
  paymentMethodDisplayName,
  RECEIPT_LOGO_SRC,
} from "../services/receipt";
import { salesReceiptStrings, returnReceiptStrings } from "../services/receiptStrings";
import { en, ar } from "@/lib/i18n/dictionary";
import type { CartLine, SalePaymentInput } from "../types";

function money2(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function line(partial: Partial<CartLine> & { product_id: string; sku: string }): CartLine {
  return {
    name_ar: "",
    name_en: partial.sku,
    barcode: null,
    unit_price: 10,
    max_qty: 100,
    qty: 1,
    image_url: null,
    ...partial,
  };
}

// Payment builders (split-payment inputs).
const cash = (amount: number, tendered?: number): SalePaymentInput => ({
  method: "cash",
  amount,
  status: "paid",
  tendered: tendered ?? amount,
});
const insta = (amount: number, status: "paid" | "pending" = "paid"): SalePaymentInput => ({
  method: "instapay",
  amount,
  status,
});

console.log("\nPOS · cart math");

test("line total + subtotal with rounding", () => {
  assert.equal(lineTotal(10.005, 3), 30.02); // 10.005 * 3 = 30.015 → 30.02
  const lines = [
    line({ product_id: "a", sku: "A", unit_price: 10, qty: 2 }),
    line({ product_id: "b", sku: "B", unit_price: 4.5, qty: 3 }),
  ];
  assert.equal(cartSubtotal(lines), 33.5);
});

test("discount: percent, fixed, clamped and invalid", () => {
  assert.equal(discountAmount(100, "percent", 10), 10);
  assert.equal(discountAmount(100, "percent", 150), 100);
  assert.equal(discountAmount(100, "percent", -5), 0);
  assert.equal(discountAmount(100, "fixed", 30), 30);
  assert.equal(discountAmount(100, "fixed", 150), 100);
  assert.equal(discountAmount(100, "none", 50), 0);
  assert.equal(validateDiscount("percent", 120), "tooHigh");
  assert.equal(validateDiscount("percent", 20), null);
  assert.equal(validateDiscount("fixed", -1), "invalid");
});

test("cart totals: total = subtotal − discount, never negative", () => {
  const lines = [
    line({ product_id: "a", sku: "A", unit_price: 25, qty: 2 }),
    line({ product_id: "b", sku: "B", unit_price: 7.5, qty: 4 }),
  ];
  const totals = cartTotals(lines, { type: "percent", value: 10 });
  assert.equal(totals.subtotal, 80);
  assert.equal(totals.discountAmount, 8);
  assert.equal(totals.total, 72);

  const overDiscounted = cartTotals(lines, { type: "fixed", value: 500 });
  assert.equal(overDiscounted.total, 0);
});

test("cash change + split-payment math", () => {
  assert.equal(cashChange(72, 100), 28);
  assert.equal(cashChange(72.5, 72.5), 0);
  assert.equal(round2(2.675), 2.68);
  assert.equal(sumPayments([{ amount: 300 }, { amount: 200 }]), 500);
  assert.equal(paymentsRemaining(500, [{ amount: 300 }, { amount: 150 }]), 50);
  assert.equal(paymentsRemaining(500, [{ amount: 500 }]), 0);
});

test("smart payment: cash 500 → instapay 500 (example 1)", () => {
  const calc = smartPaymentCalc(1000, 500, autoBalanceOther(1000, 500));
  assert.equal(calc.cashApplied, 500);
  assert.equal(calc.instapay, 500);
  assert.equal(calc.paid, 1000);
  assert.equal(calc.remaining, 0);
  assert.equal(calc.change, 0);
});

test("smart payment: instapay 700 → cash 300 (example 2)", () => {
  const calc = smartPaymentCalc(1000, autoBalanceOther(1000, 700), 700);
  assert.equal(calc.instapay, 700);
  assert.equal(calc.cashApplied, 300);
  assert.equal(calc.paid, 1000);
  assert.equal(calc.remaining, 0);
  assert.equal(calc.change, 0);
});

test("smart payment: cash 1200 → change 200 (example 3)", () => {
  const calc = smartPaymentCalc(1000, 1200, 0);
  assert.equal(calc.cashApplied, 1000);
  assert.equal(calc.cashTendered, 1200);
  assert.equal(calc.instapay, 0);
  assert.equal(calc.remaining, 0);
  assert.equal(calc.change, 200);
});

test("smart payment: unpaid remainder blocks completion", () => {
  // Cash 300 only on a 1000 sale → 700 still unpaid.
  const under = smartPaymentCalc(1000, 300, 0);
  assert.equal(under.remaining, 700);
  assert.ok(under.remaining > 0);

  // InstaPay can't overpay — it is clamped to the total.
  const clamp = smartPaymentCalc(1000, 0, 1500);
  assert.equal(clamp.instapay, 1000);
  assert.equal(clamp.remaining, 0);
  assert.equal(clamp.change, 0);

  // Cash + InstaPay exactly fill the total.
  const exact = smartPaymentCalc(1000, 400, 600);
  assert.equal(exact.paid, 1000);
  assert.equal(exact.remaining, 0);
});

test("autoBalanceOther fills the remaining amount", () => {
  assert.equal(autoBalanceOther(1000, 500), 500);
  assert.equal(autoBalanceOther(1000, 700), 300);
  assert.equal(autoBalanceOther(1000, 1200), 0);
  assert.equal(autoBalanceOther(1000, 0), 1000);
});

console.log("\nPOS · demo repository (complete sale)");

const repo = getDemoSalesRepository();
const catalog = getDemoRepository();
const inventory = getDemoInventoryRepository();

async function bySku(sku: string) {
  const list = await catalog.listProducts();
  return list.find((p) => p.sku === sku)!;
}

test("cash-only sale returns a numbered sale with recomputed totals + change", async () => {
  const coffee = await bySku("ALYQ-1001"); // price 32.5
  const sale = await repo.completeSale({
    client_ref: `test-${Date.now()}`,
    lines: [{ product_id: coffee.id, qty: 2 }],
    discount_type: "none",
    discount_value: 0,
    payments: [cash(65, 100)],
    user_id: "u1",
    user_name: "Tester",
  });

  assert.ok(/^INV-\d{6}$/.test(sale.sale_number), `sale number format: ${sale.sale_number}`);
  assert.equal(sale.status, "completed");
  assert.equal(sale.items.length, 1);
  assert.equal(sale.items[0].sku, "ALYQ-1001");
  assert.equal(sale.items[0].name_en, "Arabic Ground Coffee 250g"); // snapshot preserved
  assert.equal(sale.items[0].unit_price, 32.5);
  assert.equal(sale.items[0].quantity, 2);
  assert.equal(sale.subtotal, 65);
  assert.equal(sale.total, 65);
  assert.equal(sale.payments.length, 1);
  assert.equal(sale.payments[0].method, "cash");
  assert.equal(sale.payments[0].amount, 65);
  assert.equal(sale.amount_received, 100);
  assert.equal(sale.change, 35);
});

test("completing a sale deducts stock and writes a movement", async () => {
  const coffee = await bySku("ALYQ-1001");
  const before = coffee.stock_quantity;

  const sale = await repo.completeSale({
    client_ref: `deduct-${Date.now()}`,
    lines: [{ product_id: coffee.id, qty: 1 }],
    discount_type: "percent",
    discount_value: 10,
    payments: [cash(round2(32.5 * 0.9), 100)],
    user_id: "u1",
    user_name: "Tester",
  });

  const after = (await catalog.listProducts()).find((p) => p.id === coffee.id)!;
  assert.equal(after.stock_quantity, before - 1, "stock deducted by sold qty");
  assert.ok(after.stock_quantity >= 0, "never negative");

  const movements = await inventory.listMovementsForProduct(coffee.id);
  const saleMovement = movements.find((m) => m.notes?.includes(sale.sale_number));
  assert.ok(saleMovement, "a stock movement references the sale number");
  assert.equal(saleMovement?.type, "issue");
  assert.equal(saleMovement?.reason, "other");
  assert.equal(saleMovement?.quantity_before, before);
  assert.equal(saleMovement?.quantity_after, before - 1);
});

test("percent discount is recomputed server-side, not trusted from the client", async () => {
  const milk = await bySku("ALYQ-1020"); // 11.5
  const sale = await repo.completeSale({
    client_ref: `disc-${Date.now()}`,
    lines: [{ product_id: milk.id, qty: 2 }],
    discount_type: "percent",
    discount_value: 50,
    payments: [cash(11.5)],
    user_id: "u1",
    user_name: "Tester",
  });
  assert.equal(sale.subtotal, 23);
  assert.equal(sale.discount_amount, 11.5);
  assert.equal(sale.total, 11.5);
});

test("overselling is rejected", async () => {
  const coffee = await bySku("ALYQ-1001");
  await assert.rejects(
    repo.completeSale({
      client_ref: `oversell-${Date.now()}`,
      lines: [{ product_id: coffee.id, qty: 99 }],
      discount_type: "none",
      discount_value: 0,
      payments: [cash(1)],
      user_id: "u1",
      user_name: "Tester",
    }),
    /in stock/i,
  );
});

test("out-of-stock and non-tracked products cannot be sold", async () => {
  const juice = await bySku("ALYQ-1010"); // stock 0
  const service = await bySku("ALYQ-3001"); // stock_tracking_enabled = false
  await assert.rejects(
    repo.completeSale({
      client_ref: `oos-${Date.now()}`,
      lines: [{ product_id: juice.id, qty: 1 }],
      discount_type: "none",
      discount_value: 0,
      payments: [cash(5)],
      user_id: "u1",
      user_name: "Tester",
    }),
    /in stock|not stock-tracked|invalid|not sellable/i,
  );
  await assert.rejects(
    repo.completeSale({
      client_ref: `svc-${Date.now()}`,
      lines: [{ product_id: service.id, qty: 1 }],
      discount_type: "none",
      discount_value: 0,
      payments: [cash(500)],
      user_id: "u1",
      user_name: "Tester",
    }),
    /stock-tracked|not sellable|invalid/i,
  );
});

test("insufficient cash is rejected", async () => {
  const milk = await bySku("ALYQ-1020"); // 11.5
  await assert.rejects(
    repo.completeSale({
      client_ref: `cash-${Date.now()}`,
      lines: [{ product_id: milk.id, qty: 1 }],
      discount_type: "none",
      discount_value: 0,
      payments: [cash(11.5, 5)],
      user_id: "u1",
      user_name: "Tester",
    }),
    /insufficient/i,
  );
});

test("invalid quantities are rejected", async () => {
  const milk = await bySku("ALYQ-1020");
  await assert.rejects(
    repo.completeSale({
      client_ref: `qty-${Date.now()}`,
      lines: [{ product_id: milk.id, qty: 0 }],
      discount_type: "none",
      discount_value: 0,
      payments: [cash(100)],
      user_id: "u1",
      user_name: "Tester",
    }),
    /quantity|empty|invalid/i,
  );
  await assert.rejects(
    repo.completeSale({
      client_ref: `qty2-${Date.now()}`,
      lines: [],
      discount_type: "none",
      discount_value: 0,
      payments: [cash(100)],
      user_id: "u1",
      user_name: "Tester",
    }),
    /empty|invalid/i,
  );
});

test("payment sums that don't match the total are rejected", async () => {
  const milk = await bySku("ALYQ-1020"); // 11.5
  // Underpaid
  await assert.rejects(
    repo.completeSale({
      client_ref: `under-${Date.now()}`,
      lines: [{ product_id: milk.id, qty: 1 }],
      discount_type: "none",
      discount_value: 0,
      payments: [cash(10)],
      user_id: "u1",
      user_name: "Tester",
    }),
    /sum to/i,
  );
  // Overpaid
  await assert.rejects(
    repo.completeSale({
      client_ref: `over-${Date.now()}`,
      lines: [{ product_id: milk.id, qty: 1 }],
      discount_type: "none",
      discount_value: 0,
      payments: [cash(12)],
      user_id: "u1",
      user_name: "Tester",
    }),
    /sum to/i,
  );
});

test("concurrent completion is rejected (double-submission guard)", async () => {
  const milk = await bySku("ALYQ-1020");
  const p1 = repo.completeSale({
    client_ref: `concurrent-${Date.now()}`,
    lines: [{ product_id: milk.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [cash(11.5)],
    user_id: "u1",
    user_name: "Tester",
  });
  const p2 = repo.completeSale({
    client_ref: `concurrent-2-${Date.now()}`,
    lines: [{ product_id: milk.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [cash(11.5)],
    user_id: "u1",
    user_name: "Tester",
  });
  await assert.rejects(p2, /already being processed/i);
  await p1;
});

test("retrying the same client_ref returns the same sale (idempotency)", async () => {
  const milk = await bySku("ALYQ-1020");
  const ref = `idempotent-${Date.now()}`;
  const before = (await catalog.listProducts()).find((p) => p.id === milk.id)!.stock_quantity;

  const payload = {
    client_ref: ref,
    lines: [{ product_id: milk.id, qty: 1 }],
    discount_type: "none" as const,
    discount_value: 0,
    payments: [cash(11.5)],
    user_id: "u1",
    user_name: "Tester",
  };

  const first = await repo.completeSale(payload);
  const retry = await repo.completeSale(payload);

  assert.equal(retry.id, first.id, "same sale returned");
  assert.equal(retry.sale_number, first.sale_number, "no second invoice number burned");

  const after = (await catalog.listProducts()).find((p) => p.id === milk.id)!.stock_quantity;
  assert.equal(after, before - 1, "stock deducted exactly once");
  const sales = await repo.listSales();
  assert.equal(sales.filter((s) => s.client_ref === ref).length, 1, "only one sale persisted");
});

test("ledger keeps every movement across consecutive sales (regression)", async () => {
  const milk = await bySku("ALYQ-1020");
  const startCount = (await inventory.listMovementsForProduct(milk.id)).length;
  const refs = [`led-a-${Date.now()}`, `led-b-${Date.now()}`, `led-c-${Date.now()}`];
  for (const ref of refs) {
    await repo.completeSale({
      client_ref: ref,
      lines: [{ product_id: milk.id, qty: 1 }],
      discount_type: "none",
      discount_value: 0,
      payments: [cash(11.5)],
      user_id: "u1",
      user_name: "Tester",
    });
  }
  const endCount = (await inventory.listMovementsForProduct(milk.id)).length;
  assert.equal(endCount, startCount + refs.length, "one movement recorded per sale, none lost");
});

test("invoice numbers are sequential and never reused", async () => {
  const milk = await bySku("ALYQ-1020");
  const numbers: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const sale = await repo.completeSale({
      client_ref: `seq-${i}-${Date.now()}`,
      lines: [{ product_id: milk.id, qty: 1 }],
      discount_type: "none",
      discount_value: 0,
      payments: [cash(11.5)],
      user_id: "u1",
      user_name: "Tester",
    });
    numbers.push(sale.sale_number);
  }
  for (const n of numbers) assert.match(n, /^INV-\d{6}$/);
  assert.equal(new Set(numbers).size, numbers.length);
  const parsed = numbers.map((n) => Number(n.slice(4)));
  assert.equal(parsed[1], parsed[0] + 1);
  assert.equal(parsed[2], parsed[1] + 1);
});

test("InstaPay-only sale can be marked pending", async () => {
  const milk = await bySku("ALYQ-1020");
  const sale = await repo.completeSale({
    client_ref: `instapay-${Date.now()}`,
    lines: [{ product_id: milk.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [insta(11.5, "pending")],
    user_id: "u1",
    user_name: "Tester",
  });
  assert.equal(sale.payment_method, "instapay");
  assert.equal(sale.payment_status, "pending");
  assert.equal(sale.status, "pending");
  assert.equal(sale.payments[0].status, "pending");
  assert.equal(sale.amount_received, null);
  assert.equal(sale.change, null);
  assert.equal(sale.paid_at, null);
});

test("mixed Cash + InstaPay split payment", async () => {
  const milk = await bySku("ALYQ-1020"); // 11.5 × 4 = 46
  const sale = await repo.completeSale({
    client_ref: `split-${Date.now()}`,
    lines: [{ product_id: milk.id, qty: 4 }],
    discount_type: "none",
    discount_value: 0,
    payments: [cash(20), insta(26, "pending")],
    user_id: "u1",
    user_name: "Tester",
  });

  assert.equal(sale.total, 46);
  assert.equal(sale.payments.length, 2, "two payment records");
  assert.equal(sumPayments(sale.payments), 46, "payments sum to the total");
  assert.equal(sale.payments[0].method, "cash");
  assert.equal(sale.payments[0].amount, 20);
  assert.equal(sale.payments[0].status, "paid");
  assert.equal(sale.payments[1].method, "instapay");
  assert.equal(sale.payments[1].amount, 26);
  assert.equal(sale.payments[1].status, "pending");

  // Sale stays pending until the InstaPay portion is confirmed.
  assert.equal(sale.status, "pending");
  assert.equal(sale.payment_status, "pending");
  assert.equal(sale.amount_received, 20, "cash tendered total");
  assert.equal(sale.change, 0, "exact cash portion");
});

test("confirming a mixed sale marks only the InstaPay payment paid", async () => {
  const milk = await bySku("ALYQ-1020");
  const sale = await repo.completeSale({
    client_ref: `split-confirm-${Date.now()}`,
    lines: [{ product_id: milk.id, qty: 2 }],
    discount_type: "none",
    discount_value: 0,
    payments: [cash(11.5), insta(11.5, "pending")],
    user_id: "u1",
    user_name: "Tester",
  });
  assert.equal(sale.status, "pending");

  const confirmed = await repo.confirmPayment(sale.id, { user_id: "mgr", user_name: "Manager" });
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.payment_status, "paid");
  assert.equal(confirmed.payments[0].status, "paid"); // cash unchanged
  assert.equal(confirmed.payments[1].status, "paid"); // instapay confirmed
  assert.equal(confirmed.payments[1].paid_by, "mgr");
  assert.ok(confirmed.payments[1].paid_at);
  // totals and items preserved
  assert.equal(confirmed.total, sale.total);
  assert.equal(confirmed.items.length, sale.items.length);
});

test("confirming an InstaPay payment records who/when and preserves totals", async () => {
  const coffee2 = await bySku("ALYQ-1002"); // price 68, high stock
  const stockBefore = (await catalog.listProducts()).find((p) => p.id === coffee2.id)!.stock_quantity;

  const sale = await repo.completeSale({
    client_ref: `ip-confirm-${Date.now()}`,
    lines: [{ product_id: coffee2.id, qty: 2 }],
    discount_type: "none",
    discount_value: 0,
    payments: [insta(136, "pending")],
    user_id: "cashier-1",
    user_name: "Cashier One",
  });

  const confirmed = await repo.confirmPayment(sale.id, { user_id: "mgr-9", user_name: "Manager Nine" });
  assert.equal(confirmed.payment_method, "instapay");
  assert.equal(confirmed.payment_status, "paid");
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.paid_by, "mgr-9");
  assert.equal(confirmed.paid_by_name, "Manager Nine");
  assert.ok(confirmed.paid_at);
  assert.equal(confirmed.total, 136);
  assert.deepEqual(confirmed.items.map((i) => i.id), sale.items.map((i) => i.id));

  const stockAfter = (await catalog.listProducts()).find((p) => p.id === coffee2.id)!.stock_quantity;
  assert.equal(stockAfter, stockBefore - 2, "stock deducted once at creation");
});

test("confirming a payment is idempotent and safe for cash/voided sales", async () => {
  const coffee2 = await bySku("ALYQ-1002"); // price 68

  const instaSale = await repo.completeSale({
    client_ref: `ip-idem-${Date.now()}`,
    lines: [{ product_id: coffee2.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [insta(68, "pending")],
    user_id: "u1",
    user_name: "Tester",
  });
  const once = await repo.confirmPayment(instaSale.id, { user_id: "m", user_name: "M" });
  const twice = await repo.confirmPayment(instaSale.id, { user_id: "other", user_name: "Other" });
  assert.equal(twice.id, once.id);
  assert.equal(twice.paid_by, "m", "first confirmer preserved on repeat");
  assert.equal(twice.paid_at, once.paid_at);

  const cashSale = await repo.completeSale({
    client_ref: `cash-noop-${Date.now()}`,
    lines: [{ product_id: coffee2.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [cash(68)],
    user_id: "u1",
    user_name: "Tester",
  });
  const cashResult = await repo.confirmPayment(cashSale.id, { user_id: "m", user_name: "M" });
  assert.equal(cashResult.payment_status, "paid");
  assert.equal(cashResult.status, "completed");

  await assert.rejects(repo.confirmPayment("does-not-exist", { user_id: "m", user_name: "M" }));
});

test("receipt lists every split payment", async () => {
  const coffee2 = await bySku("ALYQ-1002"); // price 68 × 4 = 272
  const sale = await repo.completeSale({
    client_ref: `receipt-${Date.now()}`,
    lines: [{ product_id: coffee2.id, qty: 4 }],
    discount_type: "none",
    discount_value: 0,
    payments: [cash(120, 120), insta(152, "pending")],
    user_id: "u1",
    user_name: "Tester",
  });

  const html = buildReceiptHtml({
    sale,
    direction: "ltr",
    strings: {
      businessName: "ALYQ Cloud POS",
      businessTagline: "Retail",
      saleLabel: "Sale #",
      dateLabel: "Date",
      cashierLabel: "Cashier",
      itemLabel: "Item",
      qtyLabel: "Qty",
      priceLabel: "Price",
      totalLabel: "Total",
      subtotalLabel: "Subtotal",
      discountLabel: "Discount",
      paymentLabel: "Payment",
      receivedLabel: "Received",
      changeLabel: "Change",
      paidLabel: "Paid",
      remainingLabel: "Remaining",
      customerLabel: "Customer",
      customerPhoneLabel: "Phone",
      statusLabel: "Status",
      thankYou: "Thanks",
      voidedNotice: "Voided",
    },
  });
  assert.ok(html.includes("Cash"), "cash payment listed");
  assert.ok(html.includes("InstaPay"), "instapay payment listed");
  assert.ok(html.includes("(pending)"), "pending status shown");
  assert.ok(html.includes("272.00"), "grand total shown");
});

test("receipt branding: logo, boutique header, paid/remaining/change, contacts", async () => {
  const coffee2 = await bySku("ALYQ-1002"); // price 68, high stock
  const sale = await repo.completeSale({
    client_ref: `brand-${Date.now()}`,
    lines: [{ product_id: coffee2.id, qty: 2 }],
    discount_type: "none",
    discount_value: 0,
    payments: [cash(136, 140)],
    user_id: "u1",
    user_name: "Tester",
  });

  const strings = {
    businessName: "ALYQ | أَلِيق",
    businessTagline: "Inspired by you",
    saleLabel: "Sale #",
    dateLabel: "Date",
    cashierLabel: "Cashier",
    itemLabel: "Item",
    qtyLabel: "Qty",
    priceLabel: "Price",
    totalLabel: "Total",
    subtotalLabel: "Subtotal",
    discountLabel: "Discount",
    paymentLabel: "Payment",
    receivedLabel: "Received",
    changeLabel: "Change",
    paidLabel: "Paid",
    remainingLabel: "Remaining",
    customerLabel: "Customer",
    customerPhoneLabel: "Phone",
    statusLabel: "Status",
    thankYou: "Thanks",
    voidedNotice: "Voided",
  };
  const html = buildReceiptHtml({ sale, direction: "ltr", strings });

  // brand block: official logo file (centered, fixed print size) + wordmark + tagline
  assert.ok(html.includes(RECEIPT_LOGO_SRC), "official logo referenced");
  assert.ok(html.includes('class="logo"'), "logo has print sizing class");
  assert.ok(html.includes("ALYQ | أَلِيق"), "bilingual wordmark shown");
  assert.ok(html.includes("Inspired by you"), "tagline shown");
  // payment summary: total, paid, remaining, change
  assert.ok(html.includes("Paid"), "paid row shown");
  assert.ok(html.includes("Remaining"), "remaining row shown");
  assert.ok(html.includes("0.00"), "remaining 0 for a fully paid sale");
  assert.ok(html.includes("7.00"), "change 7.00 shown");
  // contact footer with exact English labels
  for (const label of ["WhatsApp", "Facebook", "Instagram", "TikTok"]) {
    assert.ok(html.includes(label), `contact label ${label}`);
  }
  assert.ok(html.includes("0150 0221712"), "whatsapp number");
  assert.ok(html.includes("ALYQ.eg"), "facebook handle");
  assert.ok(html.includes("@alyq.eg"), "social handles");
  // thermal constraints
  assert.ok(html.includes("max-width: 76mm"), "fits 58/80mm media");
  assert.ok(html.includes('dir="ltr"'), "barcode stays LTR");

  // RTL receipt keeps Arabic + brand, barcode never mirrored
  const rtl = buildReceiptHtml({ sale, direction: "rtl", strings });
  assert.ok(rtl.includes('lang="ar"'), "arabic lang");
  assert.ok(rtl.includes("ALYQ | أَلِيق"), "wordmark in RTL too");
  assert.ok(!rtl.includes("scaleX(-1)"), "symbol never mirrored");
});

test("customer info guard: customer-linked receipts require name AND phone", () => {
  // anonymous / guest — must stay printable (no behaviour change)
  assert.equal(customerInfoIssue(null, null), null, "guest with neither field is allowed");
  assert.equal(customerInfoIssue("", ""), null, "empty strings are treated as guest");
  assert.equal(customerInfoIssue(undefined, undefined), null, "undefined is treated as guest");
  assert.equal(customerInfoIssue("   ", "  "), null, "whitespace only is treated as guest");
  // fully populated customer
  assert.equal(customerInfoIssue("Test Customer", "0599111222"), null, "name + phone is allowed");
  // customer-linked but incomplete
  assert.equal(customerInfoIssue("Test Customer", null), "missingPhone", "name without phone blocked");
  assert.equal(customerInfoIssue("Test Customer", "   "), "missingPhone", "blank phone blocked");
  assert.equal(customerInfoIssue(null, "0599111222"), "missingName", "phone without name blocked");
});

// Real dictionary labels drive the receipt strings, so the assertions below
// verify the actual printed wording rather than test-only strings.
const enT = ((key: string) => (en as Record<string, string>)[key] ?? key) as never;
const arT = ((key: string) => (ar as Record<string, string>)[key] ?? key) as never;

test("full flow: sales + return receipt data matches the transaction records", async () => {
  const salesRepo = getDemoSalesRepository();
  const returnRepo = getDemoReturnRepository();

  // Start from pristine stock so the full flow (sale → return) is deterministic.
  catalog.reset();
  inventory.reset();

  const product = await bySku("ALYQ-1001");
  const unitPrice = product.selling_price;
  const qty = 3;
  const lineTotal = round2(unitPrice * qty);
  const discountValue = 2;
  const total = round2(lineTotal - discountValue);

  // ── A customer-linked sale with a discount and a split payment ──
  const sale = await salesRepo.completeSale({
    client_ref: `verify-${Date.now()}`,
    lines: [{ product_id: product.id, qty }],
    discount_type: "fixed",
    discount_value: discountValue,
    payments: [cash(round2(total / 2), total), insta(round2(total / 2))],
    customer_id: "cust-verify",
    customer_name: "Test Customer",
    customer_phone: "Test Phone Number",
    user_id: "u-verify",
    user_name: "Verify Cashier",
  });

  const salesHtml = buildReceiptHtml({
    sale,
    direction: "ltr",
    strings: salesReceiptStrings(enT),
  });

  // invoice number, date/time, cashier
  assert.ok(salesHtml.includes(sale.sale_number), "sales: invoice number");
  assert.ok(salesHtml.includes("/"), "sales: date rendered");
  assert.ok(salesHtml.includes("Verify Cashier"), "sales: cashier name");
  // customer name + phone
  assert.ok(salesHtml.includes("Test Customer"), "sales: customer name");
  assert.ok(salesHtml.includes("Test Phone Number"), "sales: customer phone");
  // items, quantities, prices, line totals
  const itemName = sale.items[0].name_en || sale.items[0].name_ar;
  assert.ok(salesHtml.includes(itemName), "sales: item name");
  assert.ok(salesHtml.includes(sale.items[0].sku), "sales: item SKU");
  assert.ok(salesHtml.includes(`>${qty}<`), "sales: quantity");
  assert.ok(salesHtml.includes(money2(unitPrice)), "sales: unit price");
  assert.ok(salesHtml.includes(money2(lineTotal)), "sales: line total");
  // discounts + total
  assert.ok(salesHtml.includes(money2(sale.subtotal)), "sales: subtotal");
  assert.ok(salesHtml.includes(`−${money2(discountValue)}`), "sales: discount amount");
  assert.ok(salesHtml.includes(money2(total)), "sales: grand total");
  // payment methods
  assert.ok(salesHtml.includes("Cash"), "sales: cash payment listed");
  assert.ok(salesHtml.includes("InstaPay"), "sales: instapay payment listed");
  assert.ok(salesHtml.includes("Paid"), "sales: paid row");
  assert.ok(salesHtml.includes("Remaining"), "sales: remaining row");
  // barcodes: invoice barcode + product barcode on the item line
  assert.ok(salesHtml.includes("<svg"), "sales: invoice barcode rendered");
  assert.ok(salesHtml.includes("<rect"), "sales: barcode has bars (no broken render)");
  if (sale.items[0].barcode) {
    assert.ok(salesHtml.includes(sale.items[0].barcode!), "sales: product barcode on the item line");
  }

  // ── A return against that same invoice: stock restored + refund created ──
  const stockBefore = (await bySku("ALYQ-1001")).stock_quantity;
  const returnQty = 1;
  const { returnRecord, refundRecord } = await returnRepo.createReturn({
    sale_id: sale.id,
    reason: "Damaged item",
    refund_method: "cash",
    items: [{ sale_item_id: sale.items[0].id, product_id: product.id, quantity: returnQty }],
    user_id: "u-verify",
    user_name: "Verify Cashier",
  });
  const stockAfter = (await bySku("ALYQ-1001")).stock_quantity;
  assert.equal(stockAfter, stockBefore + returnQty, "return restores stock");
  assert.ok(refundRecord.amount > 0, "refund record created");
  assert.equal(returnRecord.refund_amount, refundRecord.amount, "return + refund amounts agree");

  const returnHtml = buildReturnReceiptHtml({
    returnRecord,
    direction: "ltr",
    customerPhone: sale.customer_phone,
    refundNumber: refundRecord.refund_number,
    strings: returnReceiptStrings(enT, returnRecord.refund_status),
  });

  // return number + original invoice + customer + cashier
  assert.ok(returnHtml.includes(returnRecord.return_number), "return: return number");
  assert.ok(returnHtml.includes(sale.sale_number), "return: original invoice number");
  assert.ok(returnHtml.includes("Test Customer"), "return: inherited customer name");
  assert.ok(returnHtml.includes("Test Phone Number"), "return: inherited customer phone");
  assert.ok(returnHtml.includes("Verify Cashier"), "return: cashier name");
  // returned items + quantities + refund amount + method
  assert.ok(returnHtml.includes(itemName), "return: returned item name");
  assert.ok(returnHtml.includes(sale.items[0].sku), "return: returned item SKU");
  assert.ok(returnHtml.includes(`>${returnQty}<`), "return: returned quantity");
  assert.ok(returnHtml.includes(money2(returnRecord.refund_amount)), "return: refund amount");
  assert.ok(returnHtml.includes("Total refund"), "return: refund summary label");
  assert.ok(returnHtml.includes("Cash"), "return: refund method value");
  assert.ok(returnHtml.includes(refundRecord.refund_number), "return: linked refund number");
  assert.ok(returnHtml.includes("<svg") && returnHtml.includes("<rect"), "return: barcode rendered");
  // thermal layout + no missing fields
  assert.ok(returnHtml.includes("max-width: 76mm"), "return: thermal width");
  assert.ok(salesHtml.includes("max-width: 76mm"), "sales: thermal width");

  // ── Arabic RTL: real Arabic labels + right alignment ──
  const salesAr = buildReceiptHtml({ sale, direction: "rtl", strings: salesReceiptStrings(arT) });
  assert.ok(salesAr.includes('dir="rtl"'), "sales AR: rtl direction");
  assert.ok(salesAr.includes("الإجمالي"), "sales AR: arabic total label");
  assert.ok(salesAr.includes("العميل"), "sales AR: arabic customer label");
  assert.ok(salesAr.includes("text-align: right"), "sales AR: right-aligned tables");
  assert.ok(salesAr.includes("Test Customer"), "sales AR: customer data preserved");

  const returnAr = buildReturnReceiptHtml({
    returnRecord,
    direction: "rtl",
    customerPhone: sale.customer_phone,
    refundNumber: refundRecord.refund_number,
    strings: returnReceiptStrings(arT, returnRecord.refund_status),
  });
  assert.ok(returnAr.includes('dir="rtl"'), "return AR: rtl direction");
  assert.ok(returnAr.includes("إيصال مرتجع"), "return AR: arabic return title");
  assert.ok(returnAr.includes("الفاتورة الأصلية"), "return AR: arabic original-invoice label");
  assert.ok(returnAr.includes("text-align: right"), "return AR: right-aligned tables");
  assert.ok(returnAr.includes(sale.sale_number), "return AR: invoice number preserved");
  assert.ok(returnAr.includes("Test Phone Number"), "return AR: phone preserved");

  // ── Reprint determinism: same transaction → identical receipt ──
  const salesAgain = buildReceiptHtml({ sale, direction: "ltr", strings: salesReceiptStrings(enT) });
  assert.equal(salesAgain, salesHtml, "reprinting a sale yields the identical receipt");
  const returnAgain = buildReturnReceiptHtml({
    returnRecord,
    direction: "ltr",
    customerPhone: sale.customer_phone,
    refundNumber: refundRecord.refund_number,
    strings: returnReceiptStrings(enT, returnRecord.refund_status),
  });
  assert.equal(returnAgain, returnHtml, "reprinting a return yields the identical receipt");
});

test("sales receipt renders customer name + phone only when linked", () => {
  const base = {
    id: "s1",
    sale_number: "INV-000777",
    client_ref: "c1",
    status: "completed" as const,
    subtotal: 30,
    discount_type: "none" as const,
    discount_value: 0,
    discount_amount: 0,
    total: 30,
    user_id: "u1",
    user_name: "Cashier One",
    items: [
      {
        id: "i1",
        sale_id: "s1",
        product_id: "p1",
        name_ar: "قهوة",
        name_en: "Coffee",
        sku: "ALYQ-1001",
        barcode: "6281000000013",
        unit_price: 30,
        quantity: 1,
        line_total: 30,
      },
    ],
    payments: [
      {
        id: "pay1",
        sale_id: "s1",
        method: "cash" as const,
        amount: 30,
        status: "paid" as const,
        paid_at: null,
        paid_by: null,
        paid_by_name: null,
      },
    ],
    created_at: "2026-03-01T08:00:00.000Z",
    voided_at: null,
    void_reason: null,
    payment_method: "cash" as const,
    payment_status: "paid" as const,
    amount_received: 30,
    change: 0,
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
  };
  const strings = {
    businessName: "ALYQ | أَلِيق",
    businessTagline: "Inspired by you",
    saleLabel: "Sale #",
    dateLabel: "Date",
    cashierLabel: "Cashier",
    itemLabel: "Item",
    qtyLabel: "Qty",
    priceLabel: "Price",
    totalLabel: "Total",
    subtotalLabel: "Subtotal",
    discountLabel: "Discount",
    paymentLabel: "Payment",
    receivedLabel: "Received",
    changeLabel: "Change",
    customerLabel: "Customer",
    customerPhoneLabel: "Phone",
    paidLabel: "Paid",
    remainingLabel: "Remaining",
    statusLabel: "Status",
    thankYou: "Thanks",
    voidedNotice: "Voided",
  };

  // linked customer → both fields present
  const linked = buildReceiptHtml({
    sale: { ...base, customer_id: "cust-1", customer_name: "Test Customer", customer_phone: "0599111222" },
    direction: "ltr",
    strings,
  });
  assert.ok(linked.includes("Test Customer"), "sales receipt shows customer name");
  assert.ok(linked.includes("0599111222"), "sales receipt shows customer phone");

  // guest sale → no customer block, unchanged behaviour
  const guest = buildReceiptHtml({ sale: base, direction: "ltr", strings });
  assert.ok(!guest.includes("0599111222"), "guest receipt has no customer phone");
  assert.ok(!guest.includes('>Customer<') && !guest.includes(">Phone<"), "guest receipt has no customer rows");
});

test("return receipt reuses the shared design and carries return + invoice data", () => {
  const returnRecord = {
    return_number: "RET-000123",
    created_at: "2026-02-03T09:30:00.000Z",
    sale_number: "INV-000045",
    customer_name: "Smoke Customer",
    user_name: "Cashier One",
    reason: "Damaged item",
    refund_amount: 68,
    refund_method: "cash",
    refund_status: "completed" as const,
    items: [
      {
        id: "ri1",
        name_ar: "قهوة",
        name_en: "Coffee",
        sku: "ALYQ-1001",
        barcode: "6281000000013",
        unit_price: 34,
        quantity: 2,
        line_total: 68,
      },
    ],
  };
  const strings = {
    businessName: "ALYQ | أَلِيق",
    businessTagline: "Inspired by you",
    returnTitle: "Return Receipt",
    returnLabel: "Return #",
    dateLabel: "Date",
    cashierLabel: "Cashier",
    invoiceLabel: "Original invoice",
    customerLabel: "Customer",
    customerPhoneLabel: "Phone",
    itemLabel: "Item",
    qtyLabel: "Qty",
    priceLabel: "Price",
    refundLabel: "Refund",
    totalQtyLabel: "Total returned qty",
    totalRefundLabel: "Total refund",
    refundMethodLabel: "Refund method",
    refundNumberLabel: "Refund #",
    reasonLabel: "Reason",
    statusLabel: "completed",
    thankYou: "Thanks",
  };

  const html = buildReturnReceiptHtml({
    returnRecord,
    direction: "ltr",
    customerPhone: "01000000000",
    refundNumber: "REF-000123",
    strings,
  });

  // same shared shell/design as the sales receipt
  assert.ok(html.includes(RECEIPT_LOGO_SRC), "official logo referenced");
  assert.ok(html.includes("ALYQ | أَلِيق"), "boutique wordmark shown");
  assert.ok(html.includes("Inspired by you"), "tagline shown");
  assert.ok(html.includes("max-width: 76mm"), "same thermal layout");
  for (const label of ["WhatsApp", "Facebook", "Instagram", "TikTok", "0150 0221712", "ALYQ.eg", "@alyq.eg"]) {
    assert.ok(html.includes(label), `shared footer keeps ${label}`);
  }
  // return + original invoice + customer + cashier
  assert.ok(html.includes("Return Receipt"), "return title");
  assert.ok(html.includes("RET-000123"), "return number");
  assert.ok(html.includes("INV-000045"), "original invoice reference");
  assert.ok(html.includes("Smoke Customer"), "customer name");
  assert.ok(html.includes("01000000000"), "customer phone");
  assert.ok(html.includes("Cashier One"), "cashier name");
  assert.ok(html.includes("REF-000123"), "linked refund number");
  // returned items table
  assert.ok(html.includes("ALYQ-1001"), "item SKU");
  assert.ok(html.includes("6281000000013"), "item barcode");
  // refund summary
  assert.ok(html.includes("Total returned qty"), "total quantity label");
  assert.ok(html.includes("Total refund"), "total refund label");
  assert.ok(html.includes("68.00"), "refund amount");
  assert.ok(html.includes("Refund method"), "refund method label");
  assert.ok(html.includes("Cash"), "refund method value");
  assert.ok(html.includes("<svg"), "return barcode rendered");
  assert.ok(html.includes('dir="ltr"'), "barcode stays LTR");

  // RTL output
  const rtl = buildReturnReceiptHtml({ returnRecord, direction: "rtl", strings });
  assert.ok(rtl.includes('lang="ar"'), "arabic lang in RTL");
  assert.ok(rtl.includes('dir="rtl"'), "rtl direction set");
  assert.ok(rtl.includes("قهوة"), "arabic item name in RTL");

  // mixed refund methods render without changing the data model
  const mixed = buildReturnReceiptHtml({
    returnRecord: { ...returnRecord, refund_method: "cash,instapay" },
    direction: "ltr",
    strings,
  });
  assert.ok(mixed.includes("Cash + InstaPay"), "mixed refund method renders");
});

test("receipt payment labels cover cash, visa and instapay", () => {
  assert.equal(paymentMethodDisplayName("cash"), "Cash");
  assert.equal(paymentMethodDisplayName("visa"), "Visa");
  assert.equal(paymentMethodDisplayName("instapay"), "InstaPay");
});

test("receipt shows customer section only when a customer is linked", async () => {
  const customerStrings = {
    businessName: "ALYQ | أَلِيق",
    businessTagline: "Inspired by you",
    saleLabel: "Sale #",
    dateLabel: "Date",
    cashierLabel: "Cashier",
    itemLabel: "Item",
    qtyLabel: "Qty",
    priceLabel: "Price",
    totalLabel: "Total",
    subtotalLabel: "Subtotal",
    discountLabel: "Discount",
    paymentLabel: "Payment",
    receivedLabel: "Received",
    changeLabel: "Change",
    paidLabel: "Paid",
    remainingLabel: "Remaining",
    customerLabel: "Customer",
    customerPhoneLabel: "Phone",
    statusLabel: "Status",
    thankYou: "Thanks",
    voidedNotice: "Voided",
  };
  const coffee2 = await bySku("ALYQ-1002");
  const guestSale = await repo.completeSale({
    client_ref: `guest-${Date.now()}`,
    lines: [{ product_id: coffee2.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [cash(68)],
    user_id: "u1",
    user_name: "Tester",
  });
  const guestHtml = buildReceiptHtml({ sale: guestSale, direction: "ltr", strings: customerStrings });
  assert.ok(!guestHtml.includes("Customer"), "no customer section without a customer");
  assert.ok(!guestHtml.includes("Phone"), "no phone row without a customer");

  const linkedSale = await repo.completeSale({
    client_ref: `linked-${Date.now()}`,
    lines: [{ product_id: coffee2.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [cash(68)],
    customer_id: "cust-test",
    customer_name: "Smoke Customer",
    customer_phone: "0599111222",
    user_id: "u1",
    user_name: "Tester",
  });
  const linkedHtml = buildReceiptHtml({ sale: linkedSale, direction: "ltr", strings: customerStrings });
  assert.ok(linkedHtml.includes("Customer"), "customer label shown");
  assert.ok(linkedHtml.includes("Smoke Customer"), "customer name shown");
  assert.ok(linkedHtml.includes("Phone"), "phone label shown");
  assert.ok(linkedHtml.includes("0599111222"), "customer phone shown");
});

// runner — sequential so each test sees a consistent in-memory catalog
let passed = 0;
async function main() {
  for (const { name, fn } of tests) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed}/${tests.length} POS tests passed.`);
}

await main();
