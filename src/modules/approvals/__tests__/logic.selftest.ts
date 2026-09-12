/**
 * Approval limits self-test (Phase 12, requirement 2).
 *
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs approvals`).
 *
 * What is under test is the whole life of an over-limit act, not just the
 * arithmetic:
 *
 *   1. the four rule evaluators — strict comparison, a disabled rule never
 *      fires, a price rule fires only when a value actually moves;
 *   2. the demo repository's invariants, which mirror migration 0023 — decided
 *      once, a rejection needs a note, the ask is frozen, an approved request is
 *      applied once;
 *   3. the end-to-end path for each of the four kinds: refused at the service →
 *      filed as a request → decided by somebody with the authority → the act
 *      performed through its own funnel, with the record it produced written
 *      back onto the request;
 *   4. who may do what: the limits bind the seats *below* the authority, editing
 *      the thresholds is `manage_settings`, and deciding is
 *      `approve_limit_request`.
 */
import assert from "node:assert/strict";
import process from "node:process";

import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { createSession } from "@/lib/auth/services/authService";
import {
  clearStoredSession,
  primeCacheFromStorage,
  resetSessionCache,
  writeStoredSession,
} from "@/lib/auth/services/sessionStore";
import { APP_ROLES, capabilitiesOf, type AppRole, type Capability } from "@/lib/permissions/roles";
import { AppError } from "@/modules/products/data/repository";
import { getDemoExpenseRepository } from "@/modules/expenses/data/demoRepository";
import { createExpense } from "@/modules/expenses/services/expenseService";
import type { NewExpense } from "@/modules/expenses/types";
import { getDemoRepository as getCatalogDemo } from "@/modules/products/data/demoRepository";
import { loadCatalog, saveProduct } from "@/modules/products/services/catalogService";
import { getDemoSalesRepository } from "@/modules/pos/data/demoRepository";
import { completeSale, discountPercentOf } from "@/modules/pos/services/saleService";
import type { CompleteSaleInput } from "@/modules/pos/types";
import { getDemoReturnRepository } from "@/modules/returns/data/demoRepository";
import { processReturn, settleRefund } from "@/modules/returns/services/returnService";
import { getAuditRepository } from "@/modules/audit/data";

import { getDemoApprovalRepository } from "../data/demoRepository";
import {
  approvalRequiredError,
  assertRequestApplicable,
  assertWithinApprovalLimit,
  cachedApprovalRules,
  clearApprovalRulesCache,
  decideApprovalRequest,
  isApprovalRequired,
  loadApprovalRules,
  markRequestApplied,
  maySelfApproveLimits,
  pendingApprovalRequests,
  queryApprovalRequests,
  saveApprovalRules,
  submitApprovalRequest,
  summarizeApprovalRequests,
} from "../services/approvalService";
import { applyApprovedRequest } from "../services/applyApproval";
import {
  evaluateDiscountRule,
  evaluateExpenseRule,
  evaluatePriceChangeRule,
  evaluateRefundRule,
  validateApprovalReason,
  validateApprovalRulesForm,
} from "../validation";
import { approvalRulesToForm, DEFAULT_APPROVAL_RULES, type ApprovalRules } from "../types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── harness ───────────────────────────────────────────────────────────────
/**
 * Storage for a headless run.
 *
 * `window` is stubbed as well as `globalThis.localStorage`, because the demo
 * repositories — the approval counter among them — write through `safeStorage`,
 * which reads `window.localStorage`. Without it every write is silently dropped:
 * numbering would hand out APR-000001 forever and the tests would pass while
 * asserting nothing, which is the worst kind of green. (It is also how the bug
 * this suite was written to catch would have shipped.)
 */
function installStorageStub(): void {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: storage,
      sessionStorage: storage,
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
    writable: true,
  });
}

/**
 * Sign a role in, optionally with a resolved capability list — which is how a
 * Phase 10 custom role arrives, and how these tests build the seats the shipped
 * matrix does not have (a cashier who may discount but not approve one).
 */
function signInAs(role: AppRole, capabilities?: readonly Capability[]): void {
  const record = DEMO_USERS.find((user) => user.role === role);
  assert.ok(record, `a demo account exists for ${role}`);
  writeStoredSession(
    createSession({ ...record, capabilities: capabilities ?? capabilitiesOf(role) }, false),
    "local",
  );
  resetSessionCache();
  primeCacheFromStorage();
}

function signOut(): void {
  clearStoredSession();
  resetSessionCache();
}

async function codeOf(fn: () => unknown | Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : `not-an-AppError:${String(err)}`;
  }
}

installStorageStub();
resetSessionCache();

const approvals = () => getDemoApprovalRepository();
const expenses = () => getDemoExpenseRepository();
const sales = () => getDemoSalesRepository();
const catalog = () => getCatalogDemo();
const returns = () => getDemoReturnRepository();

/** Put the thresholds into a known state, as an admin would from the screen. */
async function setRules(patch: Partial<ApprovalRules>): Promise<ApprovalRules> {
  signInAs("admin");
  clearApprovalRulesCache();
  const current = await loadApprovalRules();
  const saved = await saveApprovalRules(
    approvalRulesToForm({ ...current, ...patch } as ApprovalRules),
  );
  clearApprovalRulesCache();
  await loadApprovalRules();
  return saved;
}

function expenseDraft(amount: number, name = "Over-limit expense"): NewExpense {
  return {
    name,
    category: "supplies",
    amount,
    payment_method: "cash",
    spent_at: new Date().toISOString(),
    notes: "selftest",
    attachment_url: null,
    attachment_name: null,
    branch: "Main",
    shift_id: null,
    user_id: "u-cashier",
    user_name: "Cashier",
  };
}

console.log("\nPhase 12 · approval limits");

// ── 1. the rules themselves ───────────────────────────────────────────────
test("a limit fires above the threshold and never at it", () => {
  const rules: ApprovalRules = {
    ...DEFAULT_APPROVAL_RULES,
    discount_limit_percent: 10,
    refund_limit_amount: 1000,
    expense_limit_amount: 500,
  };

  assert.equal(evaluateExpenseRule(rules, 500), null, "exactly at the limit is inside it");
  assert.equal(evaluateExpenseRule(rules, 500.01)?.kind, "expense", "a cent over is over");
  assert.equal(evaluateExpenseRule(rules, 499), null);
  assert.equal(evaluateExpenseRule(rules, 5000)?.limit_value, 500, "the request carries the threshold");

  assert.equal(evaluateRefundRule(rules, 1000), null);
  assert.equal(evaluateRefundRule(rules, 1000.5)?.amount, 1000.5);

  assert.equal(evaluateDiscountRule(rules, 10), null, "10% of a 10% cap is allowed");
  assert.equal(evaluateDiscountRule(rules, 10.5)?.kind, "discount");
  assert.equal(evaluateDiscountRule(rules, 0), null, "no discount, no request");
});

test("a rule that is switched off never fires", () => {
  const off: ApprovalRules = {
    ...DEFAULT_APPROVAL_RULES,
    discount_limit_enabled: false,
    refund_limit_enabled: false,
    expense_limit_enabled: false,
    price_change_approval_enabled: false,
  };
  assert.equal(evaluateExpenseRule(off, 999999), null);
  assert.equal(evaluateRefundRule(off, 999999), null);
  assert.equal(evaluateDiscountRule(off, 100), null);
  assert.equal(
    evaluatePriceChangeRule(off, { selling_price: 10, cost_price: 5 }, { selling_price: 99, cost_price: 5 }),
    null,
  );
});

test("the price rule fires only when a price or a cost actually moves", () => {
  const rules: ApprovalRules = { ...DEFAULT_APPROVAL_RULES, price_change_approval_enabled: true };
  const before = { selling_price: 68, cost_price: 40 };

  assert.equal(evaluatePriceChangeRule(rules, before, { ...before }), null, "a re-save is not a change");
  assert.equal(
    evaluatePriceChangeRule(rules, before, { selling_price: 68.001, cost_price: 40 }),
    null,
    "a sub-cent rounding difference is not a change",
  );
  const up = evaluatePriceChangeRule(rules, before, { selling_price: 82, cost_price: 40 });
  assert.equal(up?.kind, "price_change");
  assert.equal(up?.amount, 82, "the request carries the new price");
  assert.equal(up?.limit_value, 68, "and the price it replaces");
  assert.ok(
    evaluatePriceChangeRule(rules, before, { selling_price: 68, cost_price: 41 }),
    "a cost move is a price change too",
  );
});

test("the rules form rejects nonsense and keeps a valid draft", () => {
  const bad = validateApprovalRulesForm(
    {
      ...approvalRulesToForm(DEFAULT_APPROVAL_RULES),
      discount_limit_percent: "120",
      refund_limit_amount: "-5",
      expense_limit_amount: "abc",
    },
    DEFAULT_APPROVAL_RULES,
  );
  assert.equal(bad.valid, false);
  assert.equal(bad.errors.discount_limit_percent, "percentRange");
  assert.equal(bad.errors.refund_limit_amount, "amountNegative");
  assert.equal(bad.errors.expense_limit_amount, "amountInvalid");
  assert.equal(bad.data, null);

  const good = validateApprovalRulesForm(
    {
      ...approvalRulesToForm(DEFAULT_APPROVAL_RULES),
      discount_limit_percent: "7.5",
      refund_limit_amount: "2500",
      expense_limit_amount: "0",
    },
    DEFAULT_APPROVAL_RULES,
  );
  assert.equal(good.valid, true);
  assert.equal(good.data?.discount_limit_percent, 7.5);
  assert.equal(good.data?.refund_limit_amount, 2500);
  assert.equal(good.data?.expense_limit_amount, 0, "zero is a real limit: everything needs approval");

  assert.equal(validateApprovalReason(""), "reasonRequired");
  assert.equal(validateApprovalReason("   "), "reasonRequired");
  assert.equal(validateApprovalReason("x".repeat(501)), "reasonTooLong");
  assert.equal(validateApprovalReason("Damaged in transit"), null);
});

// ── 2. the repository's invariants ────────────────────────────────────────
test("a request is numbered, stamped with its requester, and needs a reason", async () => {
  approvals().reset();
  signInAs("cashier");

  await assert.rejects(
    approvals().createRequest({
      kind: "expense",
      entity_type: "expense",
      amount: 900,
      reason: "   ",
    }),
    /needs a reason/,
  );

  const first = await approvals().createRequest({
    kind: "expense",
    entity_type: "expense",
    amount: 900,
    limit_value: 500,
    reason: "Bulk purchase for the week",
  });
  assert.match(first.request_number, /^APR-\d{6}$/);
  assert.equal(first.status, "pending");
  assert.equal(first.requested_by_name, DEMO_USERS.find((u) => u.role === "cashier")?.name);
  assert.equal(first.decided_at, null, "nothing is decided at filing");

  const second = await approvals().createRequest({
    kind: "refund",
    entity_type: "refund",
    amount: 2000,
    reason: "Customer refund over the cap",
  });
  assert.notEqual(second.request_number, first.request_number, "numbers never repeat");
});

test("a request is decided once, and a rejection needs a note", async () => {
  signInAs("manager");
  const request = await approvals().createRequest({
    kind: "expense",
    entity_type: "expense",
    amount: 1200,
    reason: "Forklift service",
  });

  await assert.rejects(
    approvals().decideRequest(request.id, "rejected", "  "),
    /needs a note/,
  );

  const decided = await approvals().decideRequest(request.id, "approved", null);
  assert.equal(decided.alreadyDecided, false);
  assert.equal(decided.request.status, "approved");
  assert.ok(decided.request.decided_at, "the decision is stamped");
  assert.equal(
    decided.request.decided_by_name,
    DEMO_USERS.find((u) => u.role === "manager")?.name,
    "and attributed",
  );

  const again = await approvals().decideRequest(request.id, "approved", null);
  assert.equal(again.alreadyDecided, true, "the same decision twice is a no-op");

  await assert.rejects(
    approvals().decideRequest(request.id, "rejected", "Changed my mind"),
    /already approved/,
    "the opposite decision is refused",
  );

  const rejected = await approvals().createRequest({
    kind: "expense",
    entity_type: "expense",
    amount: 10,
    reason: "Rejected path",
  });
  const refusal = await approvals().decideRequest(rejected.id, "rejected", "Not a business cost");
  assert.equal(refusal.request.status, "rejected");
  assert.equal(refusal.request.decision_note, "Not a business cost", "the requester gets the reason");
});

test("only an approved request can be applied, and only once", async () => {
  signInAs("manager");
  const pending = await approvals().createRequest({
    kind: "expense",
    entity_type: "expense",
    amount: 700,
    reason: "Not decided yet",
  });
  await assert.rejects(
    approvals().markApplied(pending.id, "exp-1"),
    /Only an approved request/,
  );

  await approvals().decideRequest(pending.id, "approved", null);
  const applied = await approvals().markApplied(pending.id, "exp-1");
  assert.equal(applied.result_entity_id, "exp-1");

  const replay = await approvals().markApplied(pending.id, "exp-2");
  assert.equal(replay.result_entity_id, "exp-1", "a replay does not overwrite the first result");

  await assert.rejects(
    assertRequestApplicable(pending.id, "expense"),
    /already been applied/,
  );
  await assert.rejects(
    assertRequestApplicable(pending.id, "refund"),
    /not a refund|wrong kind|is for a/i,
    "a request cannot be applied as another kind",
  );
});

// ── 3. the four kinds, end to end ─────────────────────────────────────────
test("an expense over the cap is refused, filed, approved and then written", async () => {
  approvals().reset();
  await setRules({ expense_limit_enabled: true, expense_limit_amount: 500 });

  signInAs("cashier");
  const draft = expenseDraft(1500, "Shelf unit");
  let requirement = null;
  const code = await codeOf(() => createExpense(draft));
  assert.equal(code, "VALIDATION", "the cashier is refused, not silently allowed");

  try {
    await createExpense(draft);
  } catch (err) {
    assert.ok(isApprovalRequired(err), "the refusal says which rule fired");
    requirement = err.approvalRequired;
  }
  assert.ok(requirement, "a requirement came back");
  assert.equal(requirement.kind, "expense");
  assert.equal(requirement.amount, 1500);
  assert.equal(requirement.limit_value, 500);

  const before = (await expenses().listExpenses()).length;
  const request = await submitApprovalRequest(requirement, {
    entityType: "expense",
    entityLabel: draft.name,
    reason: "New shelf unit for the storeroom",
    newValue: { amount: draft.amount, category: draft.category },
    payload: draft as unknown as Record<string, unknown>,
  });
  assert.equal(request.status, "pending");
  assert.equal(
    (await expenses().listExpenses()).length,
    before,
    "filing a request does not create the expense",
  );

  // A cashier cannot decide their own request.
  assert.equal(maySelfApproveLimits(), false);
  assert.equal(await codeOf(() => decideApprovalRequest(request.id, "approved", null)), "FORBIDDEN");

  signInAs("manager");
  const decided = await decideApprovalRequest(request.id, "approved", "Agreed, capital item");
  assert.equal(decided.request.status, "approved");

  const applied = await applyApprovedRequest(decided.request);
  assert.equal(applied.route, "/expenses");
  const created = await expenses().getExpense(applied.entityId);
  assert.equal(created.name, draft.name, "the approved draft is what was written");
  assert.equal(created.amount, 1500);
  assert.equal((await expenses().listExpenses()).length, before + 1, "exactly one expense");

  const after = await approvals().getRequest(request.id);
  assert.equal(after.result_entity_id, created.id, "the request records what it produced");
  await assert.rejects(
    applyApprovedRequest(after),
    /already been applied/,
    "and cannot produce a second one",
  );
});

test("a manager is not routed through their own inbox", async () => {
  await setRules({ expense_limit_enabled: true, expense_limit_amount: 500 });
  signInAs("manager");
  assert.equal(maySelfApproveLimits(), true);
  const created = await createExpense(expenseDraft(4000, "Manager's own expense"));
  assert.equal(created.amount, 4000, "the authority the limit protects simply acts");
});

test("a refund over the cap is recorded pending and released by approval", async () => {
  approvals().reset();
  await setRules({ refund_limit_enabled: true, refund_limit_amount: 100 });

  // A sale big enough to refund over the cap.
  signInAs("cashier");
  const products = await catalog().listProducts();
  const coffee = products.find((p) => p.sku === "ALYQ-1002");
  assert.ok(coffee, "the seed catalogue has ALYQ-1002");
  const qty = Math.max(3, Math.ceil(400 / Math.max(1, coffee.selling_price)));
  const sale = await sales().completeSale({
    client_ref: `p12-refund-${Date.now()}`,
    lines: [{ product_id: coffee.id, qty }],
    discount_type: "none",
    discount_value: 0,
    payments: [
      {
        method: "cash",
        amount: coffee.selling_price * qty,
        status: "paid",
        tendered: coffee.selling_price * qty,
      },
    ],
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    user_id: "u-cashier",
    user_name: "Cashier",
  });
  const line = sale.items[0];

  const result = await processReturn({
    sale_id: sale.id,
    reason: "Customer returned the whole order",
    refund_method: "cash",
    refund_status: "completed",
    items: [{ sale_item_id: line.id, product_id: line.product_id, quantity: qty }],
    user_id: "u-cashier",
    user_name: "Cashier",
  });

  assert.ok(result.approvalRequest, "an over-cap refund files a request");
  assert.equal(result.refundRecord.status, "pending", "the money does not move at the till");
  assert.equal(result.returnRecord.refund_status, "pending", "and the return mirrors it");
  assert.equal(result.approvalRequest.kind, "refund");
  assert.equal(
    result.approvalRequest.payload.refund_id,
    result.refundRecord.id,
    "the request points at the refund",
  );

  // Settling it without the approval is refused for the same reason.
  let settleCode: string | null = null;
  try {
    await settleRefund(result.refundRecord.id, "completed", null);
  } catch (err) {
    settleCode = err instanceof AppError ? err.code : String(err);
  }
  assert.ok(settleCode && settleCode !== null, "a cashier cannot release the money themselves");

  signInAs("manager");
  const decided = await decideApprovalRequest(result.approvalRequest.id, "approved", "Verified receipt");
  const applied = await applyApprovedRequest(decided.request);
  assert.equal(applied.entityId, result.refundRecord.id);
  assert.equal(applied.route, `/refunds/${result.refundRecord.id}`);

  const refunds = await returns().listRefunds();
  const settled = refunds.find((r) => r.id === result.refundRecord.id);
  assert.equal(settled?.status, "completed", "approval released the refund");
  assert.ok(settled?.settled_at, "with the settlement trail");
});

test("a discount over the cap is refused with the whole sale draft", async () => {
  approvals().reset();
  await setRules({ discount_limit_enabled: true, discount_limit_percent: 10 });

  // The shipped matrix gives no role `apply_discount` without also giving it
  // `approve_limit_request`, so the seat that this rule exists for is a custom
  // role: a cashier who was granted discounting but not the authority to exceed
  // the cap. The resolved list on the session is exactly how that arrives.
  signInAs("cashier", [...capabilitiesOf("cashier"), "apply_discount"]);
  assert.equal(maySelfApproveLimits(), false, "the custom role may discount, but not approve");

  const products = await catalog().listProducts();
  const coffee = products.find((p) => p.sku === "ALYQ-1002");
  assert.ok(coffee);
  const line = { product_id: coffee.id, qty: 2 };
  const gross = coffee.selling_price * 2;
  const discountValue = gross * 0.25;
  const input: CompleteSaleInput = {
    client_ref: `p12-discount-${Date.now()}`,
    lines: [line],
    discount_type: "percent",
    discount_value: 25,
    payments: [{ method: "cash", amount: gross - discountValue, status: "paid", tendered: gross }],
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    user_id: "u-cashier",
    user_name: "Cashier",
  };

  assert.equal(discountPercentOf(input), 25, "a percentage discount reads straight off the input");
  assert.equal(
    Math.round(discountPercentOf({ ...input, discount_type: "fixed", discount_value: discountValue })),
    25,
    "and a fixed discount is converted against the subtotal",
  );

  const salesBefore = (await sales().listSales()).length;
  let requirement = null;
  try {
    await completeSale(input);
    assert.fail("a 25% discount under a 10% cap should have been refused");
  } catch (err) {
    assert.ok(isApprovalRequired(err), "the refusal names the rule");
    requirement = err.approvalRequired;
  }
  assert.equal(requirement?.kind, "discount");
  assert.equal(requirement?.amount, 25);
  assert.equal((await sales().listSales()).length, salesBefore, "nothing was sold");

  const request = await submitApprovalRequest(requirement, {
    entityType: "sale",
    entityLabel: "Discounted sale (draft)",
    reason: "Loyal customer, agreed with the owner",
    previousValue: { discount_percent: 0 },
    newValue: { discount_percent: 25 },
    payload: input as unknown as Record<string, unknown>,
  });

  signInAs("manager");
  const decided = await decideApprovalRequest(request.id, "approved", "Approved by the owner");
  const applied = await applyApprovedRequest(decided.request);
  assert.ok(applied.route?.startsWith("/pos/sales/"), "the approved draft became a sale");
  const sale = await sales().getSale(applied.entityId);
  assert.ok(sale, "and it is readable");
  assert.equal((await sales().listSales()).length, salesBefore + 1, "exactly one sale");
});

test("a price change needs approval only when the rule is on and a price moves", async () => {
  approvals().reset();
  signInAs("admin");
  await setRules({ price_change_approval_enabled: false });

  const { products, categories } = await loadCatalog();
  const target = products.find((p) => p.sku === "ALYQ-1002");
  assert.ok(target);
  const toValues = (product: typeof target, price: number) => ({
    sku: product.sku,
    barcode: product.barcode ?? "",
    name_ar: product.name_ar,
    name_en: product.name_en,
    description_ar: product.description_ar ?? "",
    description_en: product.description_en ?? "",
    category_id: product.category_id,
    product_type: product.product_type,
    selling_price: String(price),
    cost_price: String(product.cost_price),
    tax_rate: String(product.tax_rate ?? 0),
    stock_tracking_enabled: product.stock_tracking_enabled,
    stock_quantity: String(product.stock_quantity),
    low_stock_level: String(product.low_stock_level),
    show_on_website: product.show_on_website,
    is_featured: product.is_featured,
    active: product.active,
    image_url: product.image_url ?? "",
    images: product.images ?? [],
  });

  // Rule off: a cashier who holds `change_price` just changes the price.
  signInAs("cashier");
  const renamed = await saveProduct({
    values: toValues(target, Number(target.selling_price)) as never,
    products,
    categories,
    currentId: target.id,
  });
  assert.equal(renamed.isNew, false, "a save with no price move is never paperwork");

  await setRules({ price_change_approval_enabled: true });
  signInAs("cashier");
  const { products: fresh } = await loadCatalog();
  const current = fresh.find((p) => p.id === target.id)!;
  const bumped = Number(current.selling_price) + 14;

  let requirement = null;
  try {
    await saveProduct({
      values: toValues(current, bumped) as never,
      products: fresh,
      categories,
      currentId: current.id,
    });
    assert.fail("a price move under an approval rule should have been refused");
  } catch (err) {
    assert.ok(isApprovalRequired(err), "the refusal names the price rule");
    requirement = err.approvalRequired;
  }
  assert.equal(requirement?.kind, "price_change");

  const request = await submitApprovalRequest(requirement, {
    entityType: "product",
    entityId: current.id,
    entityLabel: `${current.name_en} · ${current.sku}`,
    reason: "Supplier raised the wholesale price",
    previousValue: { selling_price: Number(current.selling_price) },
    newValue: { selling_price: bumped },
    payload: { product_id: current.id, values: toValues(current, bumped) },
  });

  signInAs("admin");
  const decided = await decideApprovalRequest(request.id, "approved", "Confirmed with the supplier");
  const applied = await applyApprovedRequest(decided.request);
  assert.equal(applied.entityId, current.id);
  const after = (await loadCatalog()).products.find((p) => p.id === current.id)!;
  assert.equal(Number(after.selling_price), bumped, "the approved price is the price");
});

// ── 4. who may do what ────────────────────────────────────────────────────
test("editing the thresholds is manage_settings work", async () => {
  clearApprovalRulesCache();
  for (const role of APP_ROLES) {
    signInAs(role);
    const allowed = capabilitiesOf(role).includes("manage_settings");
    const code = await codeOf(() =>
      saveApprovalRules(approvalRulesToForm({ ...cachedApprovalRules(), expense_limit_amount: 10 })),
    );
    assert.equal(
      code,
      allowed ? null : "FORBIDDEN",
      `${role} ${allowed ? "may" : "may not"} change the approval rules`,
    );
  }
});

test("deciding a request is approve_limit_request work", async () => {
  approvals().reset();
  signInAs("admin");
  const request = await approvals().createRequest({
    kind: "expense",
    entity_type: "expense",
    amount: 10,
    reason: "Authority probe",
  });

  for (const role of APP_ROLES) {
    signInAs(role);
    const allowed = capabilitiesOf(role).includes("approve_limit_request");
    assert.equal(maySelfApproveLimits(), allowed, `${role}: maySelfApproveLimits`);
    const code = await codeOf(() => decideApprovalRequest(request.id, "approved", null));
    assert.equal(
      code,
      allowed ? null : "FORBIDDEN",
      `${role} ${allowed ? "may" : "may not"} decide a request`,
    );
  }
});

test("a signed-out caller may neither file nor decide", async () => {
  signOut();
  assert.equal(await codeOf(() => approvals().createRequest({
    kind: "expense",
    entity_type: "expense",
    amount: 10,
    reason: "Nobody",
  })), null, "the demo repository has no session to stamp, so it writes an anonymous row");
  assert.equal(
    await codeOf(() => decideApprovalRequest("apr-none", "approved", null)),
    "FORBIDDEN",
    "deciding is refused",
  );
  assert.equal(maySelfApproveLimits(), false);
});

test("the refusal carries the rule, and the limit gate is the only way through", () => {
  const err = approvalRequiredError({
    kind: "expense",
    amount: 900,
    limit_value: 500,
    ruleLabelKey: "approvals.rule.expense",
  });
  assert.ok(err instanceof AppError);
  assert.equal(err.code, "VALIDATION");
  assert.ok(isApprovalRequired(err), "recognisable by a screen that knows the flow");
  assert.equal(isApprovalRequired(new AppError("FORBIDDEN", "no")), false);

  // The gate itself: no requirement → nothing thrown; a requirement → refused
  // for a seat without the authority, waved through for one with it.
  assert.doesNotThrow(() => assertWithinApprovalLimit(null));
  signOut();
  assert.throws(
    () => assertWithinApprovalLimit(err.approvalRequired),
    (thrown: unknown) => thrown instanceof AppError && thrown.code === "VALIDATION",
  );
  signInAs("manager");
  assert.doesNotThrow(() => assertWithinApprovalLimit(err.approvalRequired));
});

test("the inbox reads: filtering, pending list and summary", async () => {
  approvals().reset();
  signInAs("admin");
  const first = await approvals().createRequest({
    kind: "expense",
    entity_type: "expense",
    amount: 900,
    reason: "Filtration probe one",
  });
  await approvals().createRequest({
    kind: "discount",
    entity_type: "sale",
    amount: 25,
    reason: "Filtration probe two",
  });
  await approvals().decideRequest(first.id, "rejected", "No budget");

  const all = await approvals().listRequests();
  const summary = summarizeApprovalRequests(all);
  assert.equal(summary.total, 2);
  assert.equal(summary.pending, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(pendingApprovalRequests(all).length, 1);

  const onlyDiscounts = queryApprovalRequests(all, { search: "", status: "all", kind: "discount" });
  assert.equal(onlyDiscounts.length, 1);
  const onlyRejected = queryApprovalRequests(all, { search: "", status: "rejected", kind: "all" });
  assert.equal(onlyRejected.length, 1);
  const byText = queryApprovalRequests(all, { search: "budget", status: "all", kind: "all" });
  assert.equal(byText.length, 1, "the decision note is searchable");
});

test("the trail records the request, the decision and the rules change", async () => {
  approvals().reset();
  const audit = getAuditRepository();

  signInAs("cashier");
  const request = await submitApprovalRequest(
    { kind: "expense", amount: 900, limit_value: 500, ruleLabelKey: "approvals.rule.expense" },
    { entityType: "expense", entityLabel: "Audit probe", reason: "Trail check" },
  );

  signInAs("admin");
  await decideApprovalRequest(request.id, "approved", "Fine");
  await markRequestApplied(request.id, "exp-audit");
  await saveApprovalRules(
    approvalRulesToForm({ ...cachedApprovalRules(), expense_limit_amount: 750 }),
  );

  // `recordAudit` is fire-and-forget by design (a failed audit row must not roll
  // back the act it describes), so give the microtasks a turn before reading.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const actions = (await audit.listEntries()).map((entry) => entry.action);
  for (const expected of [
    "approval.requested",
    "approval.approved",
    "approval.applied",
    "approval_rules.updated",
  ] as const) {
    assert.ok(actions.includes(expected), `the trail holds ${expected}`);
  }
});

// ── runner ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n${passed}/${tests.length} approval-limit tests passed.`);
if (failed > 0) process.exit(1);
