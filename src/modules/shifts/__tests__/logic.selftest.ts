/**
 * Phase 8 logic self-test (headless).
 * Run with:
 *   npx esbuild src/modules/shifts/__tests__/logic.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-phase8.mjs && node /tmp/alyq-phase8.mjs
 *
 * Covers the shift math (the acceptance scenario 1000 + 500 − 100 = 1400),
 * expense validation, shift validation and the demo shift/expense/audit
 * repository flows.
 */
import assert from "node:assert/strict";
import { computeShiftSummary, expectedCashOf, cashDifference, differenceTone } from "../services/shiftCalculations";
import { validateShiftDraft, validateCloseDraft, parseMoney } from "../validation";
import { EMPTY_SHIFT_FORM, EMPTY_CLOSE_SHIFT_FORM, type Shift } from "../types";
import { getDemoShiftRepository, resetDemoShifts } from "../data/demoRepository";
import { getDemoExpenseRepository } from "@/modules/expenses/data/demoRepository";
import { EMPTY_EXPENSE_FORM } from "@/modules/expenses/types";
import { validateExpense, roundMoney } from "@/modules/expenses/validation";
import { getDemoAuditRepository } from "@/modules/audit/data/demoRepository";
import { capabilitiesOf } from "@/lib/permissions/roles";
import {
  canAddExpense,
  canApproveAdjustment,
  canCloseShift,
  canDeleteExpense,
  canEditExpense,
  canOpenShift,
  canViewAllShifts,
  canViewAuditLog,
} from "../permissions";
import { queryAuditLog, recordAudit } from "@/modules/audit/services/auditService";
import { createSession } from "@/lib/auth/services/authService";
import {
  clearStoredSession,
  resetSessionCache,
  writeStoredSession,
} from "@/lib/auth/services/sessionStore";
import { AUDIT_ACTIONS } from "@/modules/audit/types";
import type { Sale } from "@/modules/pos/types";
import type { RefundRecord, SalesReturn } from "@/modules/returns/types";
import type { Expense } from "@/modules/expenses/types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

const OPENED_AT = "2026-03-01T08:00:00.000Z";
const NOON = new Date("2026-03-01T12:00:00.000Z");

function baseShift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: "shf-test-1",
    shift_number: "SH-000001",
    branch: "Main branch",
    register: "Register 1",
    status: "open",
    opening_cash: 1000,
    opening_at: OPENED_AT,
    opened_by: "user-demo-admin",
    opened_by_name: "ALYQ Admin",
    closing_cash: null,
    closed_at: null,
    closed_by: null,
    closed_by_name: null,
    notes: null,
    summary: null,
    adjustment_approved_by: null,
    adjustment_approved_by_name: null,
    adjustment_approved_at: null,
    created_at: OPENED_AT,
    updated_at: OPENED_AT,
    ...overrides,
  };
}

function sale(partial: {
  id: string;
  total: number;
  created_at?: string;
  status?: Sale["status"];
  payments: { method: "cash" | "instapay"; amount: number; status: "paid" | "pending" }[];
}): Sale {
  const payments = partial.payments.map((p, index) => ({
    id: `${partial.id}-p${index}`,
    sale_id: partial.id,
    method: p.method,
    amount: p.amount,
    status: p.status,
    paid_at: p.status === "paid" ? "2026-03-01T09:00:00.000Z" : null,
    paid_by: null,
    paid_by_name: null,
  }));
  return {
    id: partial.id,
    sale_number: `INV-${partial.id}`,
    client_ref: partial.id,
    status: partial.status ?? "completed",
    subtotal: partial.total,
    discount_type: "none",
    discount_value: 0,
    discount_amount: 0,
    total: partial.total,
    user_id: "user-demo-admin",
    user_name: "ALYQ Admin",
    items: [],
    payments,
    created_at: partial.created_at ?? "2026-03-01T09:00:00.000Z",
    voided_at: null,
    void_reason: null,
    payment_method: payments[0]?.method ?? "cash",
    payment_status: payments.every((p) => p.status === "paid") ? "paid" : "pending",
    amount_received: null,
    change: null,
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
  };
}

function expense(partial: Partial<Expense> & { amount: number; payment_method: Expense["payment_method"] }): Expense {
  return {
    id: `exp-${Math.random().toString(36).slice(2, 8)}`,
    expense_number: "EXP-000001",
    name: "Delivery fuel",
    category: "transport",
    spent_at: new Date().toISOString(),
    notes: null,
    attachment_url: null,
    attachment_name: null,
    branch: "Main branch",
    shift_id: "shf-test-1",
    user_id: "user-demo-admin",
    user_name: "ALYQ Admin",
    created_at: "2026-03-01T10:00:00.000Z",
    updated_at: "2026-03-01T10:00:00.000Z",
    ...partial,
  } as Expense;
}

function salesReturn(partial: Partial<SalesReturn> & { refund_amount: number }): SalesReturn {
  return {
    id: `ret-${Math.random().toString(36).slice(2, 8)}`,
    return_number: "RET-000001",
    sale_id: "sale-x",
    sale_number: "INV-sale-x",
    customer_id: null,
    customer_name: null,
    reason: "Wrong size",
    refund_method: "cash",
    refund_status: "completed",
    user_id: "user-demo-admin",
    user_name: "ALYQ Admin",
    items: [],
    created_at: "2026-03-01T10:30:00.000Z",
    ...partial,
  } as SalesReturn;
}

function refund(partial: Partial<RefundRecord> & { amount: number }): RefundRecord {
  return {
    id: `ref-${Math.random().toString(36).slice(2, 8)}`,
    refund_number: "REF-000001",
    sale_id: "sale-x",
    sale_number: "INV-sale-x",
    return_id: null,
    payment_method: "cash",
    status: "completed",
    reason: null,
    user_id: "user-demo-admin",
    user_name: "ALYQ Admin",
    created_at: "2026-03-01T10:30:00.000Z",
    ...partial,
  } as RefundRecord;
}

console.log("\nPhase 8 · shift calculations");

test("acceptance scenario: 1000 opening + 500 cash + 300 InstaPay − 100 expense = 1400 expected", () => {
  const summary = computeShiftSummary(
    baseShift(),
    {
      sales: [
        sale({ id: "s1", total: 500, payments: [{ method: "cash", amount: 500, status: "paid" }] }),
        sale({ id: "s2", total: 300, payments: [{ method: "instapay", amount: 300, status: "paid" }] }),
      ],
      returns: [],
      refunds: [],
      expenses: [expense({ amount: 100, payment_method: "cash" })],
    },
    NOON.toISOString(),
  );

  assert.equal(summary.sales_count, 2);
  assert.equal(summary.sales_total, 800);
  assert.equal(summary.cash_sales, 500, "cash sales land in the drawer");
  assert.equal(summary.instapay_sales, 300, "InstaPay is reported but not in the drawer");
  assert.equal(summary.expenses_total, 100);
  assert.equal(summary.cash_expenses, 100);
  assert.equal(summary.expected_cash, 1400, "1000 + 500 − 100 = 1400");
  assert.equal(summary.actual_cash, null, "no count yet while the shift is open");
  assert.equal(summary.difference, null);
});

test("non-cash expenses and InstaPay refunds do not move the drawer", () => {
  const summary = computeShiftSummary(
    baseShift({ opening_cash: 200 }),
    {
      sales: [sale({ id: "s1", total: 100, payments: [{ method: "cash", amount: 100, status: "paid" }] })],
      returns: [],
      refunds: [
        refund({ amount: 50, payment_method: "instapay" }),
        refund({ amount: 30, payment_method: "visa" }),
      ],
      expenses: [expense({ amount: 40, payment_method: "instapay" })],
    },
    NOON.toISOString(),
  );

  assert.equal(summary.expected_cash, 300, "200 + 100, no cash outflows");
  assert.equal(summary.refunds_total, 80);
  assert.equal(summary.expenses_total, 40);
});

test("cash refunds reduce the expected cash", () => {
  const summary = computeShiftSummary(
    baseShift({ opening_cash: 1000 }),
    {
      sales: [sale({ id: "s1", total: 250, payments: [{ method: "cash", amount: 250, status: "paid" }] })],
      returns: [salesReturn({ refund_amount: 250 })],
      refunds: [refund({ amount: 250, payment_method: "cash" })],
      expenses: [],
    },
    NOON.toISOString(),
  );

  assert.equal(summary.returns_total, 250);
  assert.equal(summary.cash_refunds, 250);
  assert.equal(summary.expected_cash, 1000, "1000 + 250 − 250");
});

test("pending InstaPay and voided sales stay out of the totals", () => {
  const summary = computeShiftSummary(
    baseShift({ opening_cash: 0 }),
    {
      sales: [
        sale({ id: "s1", total: 400, payments: [{ method: "instapay", amount: 400, status: "pending" }] }),
        sale({
          id: "s2",
          total: 900,
          status: "voided",
          payments: [{ method: "cash", amount: 900, status: "paid" }],
        }),
      ],
      returns: [],
      refunds: [refund({ amount: 60, status: "pending" })],
      expenses: [],
    },
    NOON.toISOString(),
  );

  assert.equal(summary.sales_count, 1, "the voided sale is not revenue");
  assert.equal(summary.sales_total, 400);
  assert.equal(summary.cash_sales, 0);
  assert.equal(summary.instapay_sales, 0);
  assert.equal(summary.instapay_pending, 400);
  assert.equal(summary.voided_count, 1);
  assert.equal(summary.voided_total, 900);
  assert.equal(summary.pending_refunds, 60);
  assert.equal(summary.expected_cash, 0);
});

test("mixed payments are counted per method", () => {
  const summary = computeShiftSummary(
    baseShift({ opening_cash: 100 }),
    {
      sales: [
        sale({
          id: "s1",
          total: 500,
          payments: [
            { method: "cash", amount: 300, status: "paid" },
            { method: "instapay", amount: 200, status: "paid" },
          ],
        }),
      ],
      returns: [],
      refunds: [],
      expenses: [],
    },
    NOON.toISOString(),
  );

  assert.equal(summary.mixed_count, 1);
  assert.equal(summary.mixed_total, 500);
  assert.equal(summary.cash_sales, 300);
  assert.equal(summary.instapay_sales, 200);
  assert.equal(summary.expected_cash, 400, "100 + 300");
});

test("records outside the shift window are ignored", () => {
  const summary = computeShiftSummary(
    baseShift({ opening_cash: 100, opening_at: "2026-03-01T09:00:00.000Z" }),
    {
      sales: [
        sale({
          id: "before",
          total: 777,
          created_at: "2026-03-01T07:00:00.000Z",
          payments: [{ method: "cash", amount: 777, status: "paid" }],
        }),
        sale({
          id: "inside",
          total: 50,
          created_at: "2026-03-01T09:30:00.000Z",
          payments: [{ method: "cash", amount: 50, status: "paid" }],
        }),
      ],
      returns: [],
      refunds: [],
      expenses: [
        expense({
          amount: 20,
          payment_method: "cash",
          spent_at: "2026-03-01T07:00:00.000Z",
          shift_id: null,
        }),
      ],
    },
    NOON.toISOString(),
  );

  assert.equal(summary.sales_count, 1);
  assert.equal(summary.sales_total, 50);
  assert.equal(summary.expenses_total, 0, "expense before the window is not this shift's");
  assert.equal(summary.expected_cash, 150);
});

test("closed shift window is exclusive at the close timestamp", () => {
  const summary = computeShiftSummary(
    baseShift({
      opening_cash: 0,
      opening_at: "2026-03-01T09:00:00.000Z",
      closing_cash: 100,
      closed_at: "2026-03-01T10:00:00.000Z",
      status: "closed",
    }),
    {
      sales: [
        sale({
          id: "in",
          total: 100,
          created_at: "2026-03-01T09:59:00.000Z",
          payments: [{ method: "cash", amount: 100, status: "paid" }],
        }),
        sale({
          id: "after",
          total: 999,
          created_at: "2026-03-01T10:00:00.000Z",
          payments: [{ method: "cash", amount: 999, status: "paid" }],
        }),
      ],
      returns: [],
      refunds: [],
      expenses: [],
    },
    NOON.toISOString(),
  );

  assert.equal(summary.sales_count, 1);
  assert.equal(summary.expected_cash, 100);
  assert.equal(summary.actual_cash, 100);
  assert.equal(summary.difference, 0, "counted exactly the expected cash");
});

test("cash difference and tone helpers", () => {
  assert.equal(cashDifference(1400, 1400), 0);
  assert.equal(cashDifference(1385.5, 1400), -14.5);
  assert.equal(expectedCashOf({ opening_cash: 1000, cash_sales: 500, cash_refunds: 0, cash_expenses: 100 }), 1400);
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(differenceTone(null), "neutral");
  assert.equal(differenceTone(0), "success");
  assert.equal(differenceTone(-5), "warning");
  assert.equal(differenceTone(-5.01), "danger");
  assert.equal(differenceTone(120), "danger");
});

console.log("\nPhase 8 · validation");

test("shift draft requires branch, register and a valid opening cash", () => {
  const empty = validateShiftDraft(EMPTY_SHIFT_FORM);
  assert.equal(empty.branch, "shifts.error.branchRequired");
  assert.equal(empty.opening_cash, "shifts.error.openingRequired");

  const negative = validateShiftDraft({ ...EMPTY_SHIFT_FORM, branch: "Main", opening_cash: "-10" });
  assert.equal(negative.opening_cash, "shifts.error.openingNegative");

  const ok = validateShiftDraft({ ...EMPTY_SHIFT_FORM, branch: "Main", opening_cash: "1,000" });
  assert.deepEqual(ok, {});
  assert.equal(parseMoney("1,000"), 1000);
});

test("close draft requires a counted cash amount", () => {
  const empty = validateCloseDraft(EMPTY_CLOSE_SHIFT_FORM);
  assert.equal(empty.closing_cash, "shifts.error.closingRequired");

  const ok = validateCloseDraft({ closing_cash: "1400", notes: "All good" });
  assert.deepEqual(ok, {});
});

test("expense validation: name, positive amount, category, method", () => {
  const empty = validateExpense({ ...EMPTY_EXPENSE_FORM });
  assert.equal(empty.errors.name, "expenses.error.nameRequired");
  assert.equal(empty.errors.amount, "expenses.error.amountPositive");
  assert.equal(empty.valid, false);

  const good = validateExpense({
    ...EMPTY_EXPENSE_FORM,
    name: "Delivery fuel",
    amount: "100",
    category: "transport",
    payment_method: "cash",
  });
  assert.equal(good.valid, true);
  assert.equal(good.amount, 100);

  const bad = validateExpense({ ...EMPTY_EXPENSE_FORM, name: "X", amount: "0", category: "transport" });
  assert.equal(bad.errors.amount, "expenses.error.amountPositive");
});

test("permission matrix: till actions are staff-level, oversight stays manager/admin", () => {
  const user = (role: string) => ({ id: `u-${role}`, name: role, role }) as never;

  // Till work: admin, manager, inventory clerk (and a cashier where offered).
  for (const role of ["admin", "manager", "inventory_clerk", "cashier"]) {
    assert.equal(canOpenShift(user(role)), true, `${role} may open a shift`);
    assert.equal(canCloseShift(user(role)), true, `${role} may close a shift`);
    assert.equal(canAddExpense(user(role)), true, `${role} may add an expense`);
  }
  assert.equal(canOpenShift(user("viewer")), false, "viewer may not open a shift");
  assert.equal(canCloseShift(user("viewer")), false, "viewer may not close a shift");
  assert.equal(canAddExpense(user("viewer")), false, "viewer may not add an expense");

  // Oversight: managers and admins only.
  for (const role of ["inventory_clerk", "cashier", "viewer"]) {
    assert.equal(canApproveAdjustment(user(role)), false, `${role} may not approve adjustments`);
    assert.equal(canEditExpense(user(role)), false, `${role} may not edit an expense`);
    assert.equal(canDeleteExpense(user(role)), false, `${role} may not delete an expense`);
    assert.equal(canViewAuditLog(user(role)), false, `${role} may not read the audit log`);
  }
  for (const role of ["admin", "manager"]) {
    assert.equal(canApproveAdjustment(user(role)), true, `${role} may approve adjustments`);
    assert.equal(canEditExpense(user(role)), true, `${role} may edit an expense`);
    assert.equal(canDeleteExpense(user(role)), true, `${role} may delete an expense`);
    assert.equal(canViewAuditLog(user(role)), true, `${role} may read the audit log`);
  }

  // Reading shift history is allowed for every internal role.
  for (const role of ["admin", "manager", "inventory_clerk", "viewer"]) {
    assert.equal(canViewAllShifts(user(role)), true, `${role} may read shift history`);
  }
});

test("audit action list covers every Phase 8 event", () => {
  for (const action of [
    "shift.opened",
    "shift.closed",
    "expense.created",
    "expense.updated",
    "expense.deleted",
    "shift.adjustment.approved",
  ]) {
    assert.ok(AUDIT_ACTIONS.includes(action as (typeof AUDIT_ACTIONS)[number]), `${action} is auditable`);
  }
});

console.log("\nPhase 8 · demo repositories");

test("open → expense → close persists the shift with a frozen summary", async () => {
  resetDemoShifts();
  const shifts = getDemoShiftRepository();
  const expenses = getDemoExpenseRepository();

  const shift = await shifts.openShift({
    branch: "Main branch",
    register: "Register 1",
    opening_cash: 1000,
    opened_by: "user-demo-admin",
    opened_by_name: "ALYQ Admin",
  });
  assert.match(shift.shift_number, /^SH-\d{6}$/);
  assert.equal(shift.status, "open");
  assert.equal(shift.opening_cash, 1000);

  const open = await shifts.getOpenShift();
  assert.equal(open?.id, shift.id);

  // A second shift may not be opened while one is live.
  await assert.rejects(
    () =>
      shifts.openShift({
        branch: "Main branch",
        register: "Register 2",
        opening_cash: 500,
        opened_by: "user-demo-admin",
        opened_by_name: "ALYQ Admin",
      }),
    /already open/,
  );

  const created = await expenses.createExpense({
    name: "Delivery fuel",
    category: "transport",
    amount: 100,
    payment_method: "cash",
    spent_at: new Date().toISOString(),
    notes: null,
    attachment_url: null,
    attachment_name: null,
    branch: "Main branch",
    shift_id: shift.id,
    user_id: "user-demo-admin",
    user_name: "ALYQ Admin",
  });
  assert.match(created.expense_number, /^EXP-\d{6}$/);
  assert.equal(created.shift_id, shift.id);

  const liveSummary = computeShiftSummary(shift, {
    sales: [
      sale({
        id: "s1",
        total: 500,
        created_at: new Date().toISOString(),
        payments: [{ method: "cash", amount: 500, status: "paid" }],
      }),
      sale({
        id: "s2",
        total: 300,
        created_at: new Date().toISOString(),
        payments: [{ method: "instapay", amount: 300, status: "paid" }],
      }),
    ],
    returns: [],
    refunds: [],
    expenses: await expenses.listExpenses(),
  });
  assert.equal(liveSummary.expected_cash, 1400);

  const closed = await shifts.closeShift(shift.id, {
    closing_cash: 1395,
    notes: "Till short by 5",
    closed_by: "user-demo-admin",
    closed_by_name: "ALYQ Admin",
    summary: liveSummary,
  });

  assert.equal(closed.status, "closed");
  assert.equal(closed.closing_cash, 1395);
  assert.equal(closed.summary?.expected_cash, 1400, "the snapshot keeps the expected cash");
  assert.equal(closed.summary?.actual_cash, 1395);
  assert.equal(closed.summary?.difference, -5);
  assert.equal(closed.notes, "Till short by 5");

  // Closing twice is rejected.
  await assert.rejects(
    () =>
      shifts.closeShift(shift.id, {
        closing_cash: 1400,
        notes: null,
        closed_by: "user-demo-admin",
        closed_by_name: "ALYQ Admin",
        summary: liveSummary,
      }),
    /already closed/,
  );

  const listed = await shifts.listShifts();
  assert.equal(listed.length, 1);
  assert.equal(await shifts.getOpenShift(), null, "no shift is open after close");

  const approved = await shifts.approveAdjustment(closed.id, "user-mgr", "Branch Manager");
  assert.equal(approved.adjustment_approved_by_name, "Branch Manager");
  assert.ok(approved.adjustment_approved_at);
});

test("expense repository: update, delete and totals", async () => {
  const expenses = getDemoExpenseRepository();
  const list = await expenses.listExpenses();
  const first = list[0];
  assert.ok(first, "the expense from the previous test is persisted");

  const updated = await expenses.updateExpense(first.id, { amount: 120, notes: "Adjusted" });
  assert.equal(updated.amount, 120);
  assert.equal(updated.notes, "Adjusted");

  const removed = await expenses.deleteExpense(first.id);
  assert.equal(removed, undefined);
  const after = await expenses.listExpenses();
  assert.equal(after.length, 0);
});

test("audit repository is append-only and queryable", async () => {
  const audit = getDemoAuditRepository();
  const entry = await audit.append({
    action: "shift.opened",
    entity: "shift",
    entity_id: "shf-x",
    entity_label: "SH-000009",
    details: { opening_cash: 1000 },
    user_id: "user-demo-admin",
    user_name: "ALYQ Admin",
  });
  assert.ok(entry.id);
  assert.equal(entry.action, "shift.opened");

  const all = await audit.listEntries();
  assert.ok(all.some((e) => e.id === entry.id));

  const filtered = queryAuditLog(all, { search: "SH-000009", action: "all" });
  assert.equal(filtered.length, 1);
  const none = queryAuditLog(all, { search: "", action: "expense.deleted" });
  assert.equal(none.length, 0, "no expense.deleted entry recorded yet");
});

test("audit entries carry the signed-in user (Authentication phase)", async () => {
  // Phase 8 wrote entries from a fabricated demo identity; now the actor comes
  // from the real session. With no session the entry is still written, but it is
  // never attributed to anybody — the fail-closed behaviour the audit screen
  // relies on. A minimal in-memory storage stub keeps this headless.
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  resetSessionCache();

  const anonymous = await recordAudit({
    action: "expense.created",
    entity: "expense",
    entity_id: "exp-anon",
    entity_label: "EXP-000101",
    details: { amount: 10 },
  });
  assert.equal(anonymous?.user_id, "", "no phantom actor when signed out");
  assert.equal(anonymous?.user_name, "");

  writeStoredSession(
    createSession(
      // `capabilities` is required on an identity (Phase 10): a user with no
      // resolved list would read as "unknown" instead of "denied". The fixture
      // derives it from the role rather than restating the matrix.
      {
        id: "user-cashier",
        username: "cashier",
        name: "Cashier One",
        role: "cashier",
        capabilities: capabilitiesOf("cashier"),
      },
      false,
    ),
    "session",
  );
  const attributed = await recordAudit({
    action: "expense.created",
    entity: "expense",
    entity_id: "exp-cashier",
    entity_label: "EXP-000102",
    details: { amount: 25 },
  });
  assert.equal(attributed?.user_id, "user-cashier", "the session user is recorded as the actor");
  assert.equal(attributed?.user_name, "Cashier One");

  clearStoredSession();
  resetSessionCache();
});

// runner — sequential so each test sees a consistent repository state
let passed = 0;
async function main(): Promise<void> {
  for (const { name, fn } of tests) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed}/${tests.length} Phase 8 tests passed.\n`);
}

await main();
