/**
 * Enforcement self-test — Phases 11–14, requirements 1 and 9.
 *
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs enforcement`).
 *
 * The claim under test is the one the phase exists to make true: **hiding a
 * button is not a security control.** So this suite does not look at components.
 * It signs a role in, calls the service funnels the way a screen — or a
 * hand-built request — would, and asserts the refusal happens in the service:
 *
 *   1. the register in `actions.ts` is real: every entry names a capability the
 *      model has, a file that exists, and a guard that file exports;
 *   2. every role is refused exactly the actions it lacks, for all 5 roles ×
 *      every registered action (no hand-maintained list of expectations);
 *   3. the *resolved* capability list decides, not the role label — which is
 *      what makes a Phase 10 custom role enforceable without new code;
 *   4. signed out means refused everywhere;
 *   5. the funnels actually call their guards (a guard nobody calls is décor);
 *   6. the till-level splits behave as designed: a cashier may record a return
 *      but not settle its refund, may change a price but not adjust stock;
 *   7. the refusals that are about *immutability* rather than permission say so
 *      with VALIDATION, not FORBIDDEN — sales and refunds are not editable by
 *      anyone, and the error must not imply that a bigger role could.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  SENSITIVE_ACTIONS,
  assertSensitiveAction,
  mayPerform,
  registeredCapabilities,
} from "../actions";
import {
  APP_ROLES,
  CAPABILITIES,
  capabilitiesOf,
  hasCapability,
  type AppRole,
  type Capability,
} from "../roles";
import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { createSession } from "@/lib/auth/services/authService";
import {
  clearStoredSession,
  primeCacheFromStorage,
  resetSessionCache,
  writeStoredSession,
} from "@/lib/auth/services/sessionStore";
import { AppError } from "@/modules/products/data/repository";

import * as auditService from "@/modules/audit/services/auditService";
import * as backupService from "@/modules/backup/services/backupService";
import * as expenseService from "@/modules/expenses/services/expenseService";
import * as inventoryService from "@/modules/inventory/services/inventoryService";
import * as catalogService from "@/modules/products/services/catalogService";
import * as saleService from "@/modules/pos/services/saleService";
import * as reportAccess from "@/modules/reports/services/reportAccess";
import * as reservationRepair from "@/modules/online/services/reservationRepair";
import * as returnService from "@/modules/returns/services/returnService";
import * as shiftService from "@/modules/shifts/services/shiftService";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── harness ───────────────────────────────────────────────────────────────
/** Minimal in-memory Storage so a session can exist outside a browser. */
function installStorageStub(): void {
  const make = (map: Map<string, string>) => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { value: make(local), configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: make(session), configurable: true });
}

/**
 * Sign a demo role in.
 *
 * `capabilities` overrides the resolved list on the session, which is exactly
 * how a custom role arrives (see `capabilitiesOfUser`): the overlay is carried
 * on the user, not derived from the label.
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

/** The error code an app refusal carries, or null when nothing was thrown. */
async function refusalCode(fn: () => unknown | Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : `not-an-AppError:${String(err)}`;
  }
}

function refusalCodeSync(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : `not-an-AppError:${String(err)}`;
  }
}

/** Repo root, found by walking up from cwd so the runner's location is irrelevant. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "src/lib/permissions/actions.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the repository root from " + process.cwd());
}

console.log("\nPhases 11–14 · sensitive-action enforcement");

// ── 1. the register is real ───────────────────────────────────────────────
test("every register entry names a real capability, file and exported guard", () => {
  const root = repoRoot();
  const keys = new Set<string>();
  const catalogue = new Set<string>(CAPABILITIES);

  for (const action of SENSITIVE_ACTIONS) {
    assert.ok(!keys.has(action.key), `${action.key} is registered once`);
    keys.add(action.key);
    assert.ok(catalogue.has(action.capability), `${action.key}: '${action.capability}' is in the model`);
    assert.ok(action.key.includes("."), `${action.key} reads as entity.action`);
    assert.ok(action.db.trim().length > 0, `${action.key}: says what the database does about it`);

    const file = path.join(root, action.file);
    assert.ok(fs.existsSync(file), `${action.key}: ${action.file} exists`);
    const source = fs.readFileSync(file, "utf8");
    assert.ok(
      new RegExp(`export function ${action.guard}\\b`).test(source),
      `${action.key}: ${action.file} exports ${action.guard}()`,
    );
    assert.ok(
      source.includes(`assertSensitiveAction("${action.key}")`),
      `${action.key}: ${action.guard}() really asserts that key`,
    );
  }

  assert.ok(SENSITIVE_ACTIONS.length >= 30, `the register covers the phase (${SENSITIVE_ACTIONS.length} actions)`);
  for (const capability of registeredCapabilities()) {
    assert.ok(catalogue.has(capability), `registered capability '${capability}' exists in the matrix`);
  }
});

// ── 2. refusal matrix, derived not listed ─────────────────────────────────
test("each role is refused exactly the sensitive actions it lacks", () => {
  const refusals = new Map<AppRole, number>();
  const refusedCapabilities = new Map<AppRole, string[]>();
  for (const role of APP_ROLES) {
    installStorageStub();
    signInAs(role);
    let refused = 0;
    const lacking: string[] = [];
    for (const action of SENSITIVE_ACTIONS) {
      const allowed = hasCapability(role, action.capability);
      const code = refusalCodeSync(() => assertSensitiveAction(action.key));
      if (allowed) {
        assert.equal(code, null, `${role} may '${action.key}' (${action.capability})`);
        assert.equal(mayPerform(action.key), true, `${role}: mayPerform agrees for '${action.key}'`);
      } else {
        assert.equal(code, "FORBIDDEN", `${role} is refused '${action.key}' (${action.capability})`);
        assert.equal(mayPerform(action.key), false, `${role}: mayPerform agrees on refusing '${action.key}'`);
        refused += 1;
        lacking.push(action.capability);
      }
    }
    refusals.set(role, refused);
    refusedCapabilities.set(role, lacking);
  }

  // The owner can always run the shop: an action an admin is refused would be a
  // hole in the matrix rather than a control.
  assert.equal(refusals.get("admin"), 0, "admin is refused nothing");

  // A manager runs the shop too, and is refused only the capabilities admin
  // keeps to itself — the ones that decide who holds capabilities and what the
  // system-wide rules are. Asserting the *kind* of refusal, rather than a count,
  // keeps this true as the register grows.
  //
  // Phase 18 adds two that are not `manage_` and belong here all the same, both
  // about custody of the data rather than administration of the app:
  //   restore_backup — deletes every row written since the snapshot, sales
  //                    included: a decision about the business, not the shift.
  //   export_backup  — the file is the whole database, customer book and staff
  //                    directory with it. A manager may see that a snapshot
  //                    exists and take one; carrying a copy out is the owner's.
  const ADMIN_ONLY = /^(manage_|restore_backup$|export_backup$)/;
  for (const capability of refusedCapabilities.get("manager") ?? []) {
    assert.ok(
      ADMIN_ONLY.test(capability),
      `manager is refused '${capability}', which is an admin-only authority`,
    );
  }

  // Every seat below them is gated, and the read-only seat is gated hardest.
  for (const role of ["cashier", "inventory_clerk", "viewer"] as const) {
    assert.ok(
      (refusals.get(role) ?? 0) > 0,
      `${role} is not omnipotent (${refusals.get(role)} refusals)`,
    );
  }
  assert.ok(
    (refusals.get("viewer") ?? 0) > (refusals.get("cashier") ?? 0),
    "the read-only seat is refused more than the till seat",
  );
  assert.ok(
    (refusals.get("cashier") ?? 0) > 0 && (refusals.get("inventory_clerk") ?? 0) > 0,
    "the till and the warehouse each have actions only an overseer may take",
  );
});

test("a viewer may look and extract, but never write", () => {
  const admin = capabilitiesOf("admin");
  for (const action of SENSITIVE_ACTIONS) {
    assert.ok(
      admin.includes(action.capability),
      `admin holds '${action.capability}' for ${action.key} — an owner can always run the shop`,
    );
  }

  // The viewer role is the app's read-only seat. What it keeps is exactly the
  // read/export capabilities — so the assertion is about the *kind* of thing a
  // viewer is still allowed to do, which cannot rot when the register grows.
  const viewer = capabilitiesOf("viewer");
  const viewerAllows = SENSITIVE_ACTIONS.filter((a) => viewer.includes(a.capability));
  assert.ok(viewerAllows.length > 0, "viewer is not refused literally everything");
  for (const action of viewerAllows) {
    assert.ok(
      /^(view|export)_/.test(action.capability),
      `viewer only keeps read/export gates, not '${action.capability}' (${action.key})`,
    );
  }
  const viewerWrites = SENSITIVE_ACTIONS.filter((a) => !/^(view|export)_/.test(a.capability));
  for (const action of viewerWrites) {
    assert.ok(
      !viewer.includes(action.capability),
      `viewer is refused the write action '${action.key}'`,
    );
  }
});

// ── 3. resolved capabilities decide, not the label ────────────────────────
test("a custom capability set on the session overrides the role label", () => {
  installStorageStub();
  // An "admin" session carrying only `sell`: the label says everything, the
  // resolved list says one thing. Enforcement must follow the list — that is
  // what makes Phase 10 custom roles work without touching a single service.
  signInAs("admin", ["sell"]);
  assert.equal(refusalCodeSync(() => saleService.assertCanCompleteSale()), null, "sell is granted");
  assert.equal(
    refusalCodeSync(() => expenseService.assertCanApproveExpense()),
    "FORBIDDEN",
    "an admin-labelled session without approve_expense is refused",
  );
  assert.equal(refusalCodeSync(() => auditService.assertCanViewAudit()), "FORBIDDEN");
  assert.equal(refusalCodeSync(() => returnService.assertCanSettleRefund()), "FORBIDDEN");

  // …and the other direction: a cashier carrying a manager's overlay.
  signInAs("cashier", [...capabilitiesOf("cashier"), "adjust_stock", "approve_refund"]);
  assert.equal(refusalCodeSync(() => inventoryService.assertCanAdjustStock()), null);
  assert.equal(refusalCodeSync(() => returnService.assertCanSettleRefund()), null);
});

// ── 4. signed out ─────────────────────────────────────────────────────────
test("a signed-out caller is refused every sensitive action", () => {
  installStorageStub();
  signOut();
  for (const action of SENSITIVE_ACTIONS) {
    assert.equal(
      refusalCodeSync(() => assertSensitiveAction(action.key)),
      "FORBIDDEN",
      `signed out: '${action.key}' refused`,
    );
  }
});

// ── 5. the funnels call their guards ──────────────────────────────────────
/**
 * One entry per write path the phase gates. Each is called as a screen would
 * call it, with a payload that would be *wrong* on its own terms — the guard
 * must fire first, which is the only way to prove the refusal is a permission
 * decision rather than an accident of validation order.
 */
const FUNNELS: { name: string; call: () => unknown | Promise<unknown> }[] = [
  { name: "expenseService.createExpense", call: () => expenseService.createExpense({} as never) },
  { name: "expenseService.updateExpense", call: () => expenseService.updateExpense("exp-x", {} as never) },
  { name: "expenseService.deleteExpense", call: () => expenseService.deleteExpense("exp-x") },
  { name: "inventoryService.adjustStock", call: () => inventoryService.adjustStock({
      productId: "p-x",
      type: "adjustment_in",
      reason: "recount",
      quantity: 1,
      notes: null,
    }) },
  { name: "shiftService.openShift", call: () => shiftService.openShift({} as never) },
  { name: "shiftService.closeShift", call: () => shiftService.closeShift("shf-x", {} as never) },
  { name: "shiftService.approveShiftAdjustment", call: () => shiftService.approveShiftAdjustment("shf-x", "u-9", "Manager") },
  { name: "auditService.loadAuditLog", call: () => auditService.loadAuditLog() },
  { name: "catalogService.saveProduct", call: () => catalogService.saveProduct({
      values: {} as never,
      products: [],
      categories: [],
      currentId: undefined,
    }) },
  { name: "catalogService.saveCategory", call: () => catalogService.saveCategory({
      values: {} as never,
      categories: [],
      currentId: undefined,
    }) },
  { name: "catalogService.deleteCategory", call: () => catalogService.deleteCategory("cat-x", { products: [], categories: [] }) },
  { name: "catalogService.setProductActive", call: () => catalogService.setProductActive("p-x", false) },
  { name: "catalogService.deleteProduct", call: () => catalogService.deleteProduct("p-x") },
  { name: "saleService.voidSale", call: () => saleService.voidSale("sale-x", {} as never) },
  { name: "saleService.confirmPayment", call: () => saleService.confirmPayment("sale-x", {} as never) },
  { name: "saleService.editSale", call: () => saleService.editSale("sale-x", {} as never) },
  { name: "saleService.deleteSale", call: () => saleService.deleteSale("sale-x") },
  { name: "returnService.processReturn", call: () => returnService.processReturn({} as never) },
  { name: "returnService.settleRefund", call: () => returnService.settleRefund("ref-x", "completed", null) },
  { name: "reportAccess.assertCanExport(report)", call: () => reportAccess.assertCanExport("report") },
  // Settling a website hold asks for the stock ledger's own capability, so the
  // till seat that works the online queue is refused here exactly as it is on
  // the screen — and the refusal happens before any row is read.
  { name: "reservationRepair.repairHold", call: () => reservationRepair.repairHold({} as never, "Left behind by an interrupted deployment") },
  { name: "reservationRepair.restoreHold", call: () => reservationRepair.restoreHold({} as never, "Left behind by an interrupted deployment") },
  { name: "reservationRepair.repairAllFindings", call: () => reservationRepair.repairAllFindings({} as never, "Left behind by an interrupted deployment") },
  { name: "reportAccess.assertCanExport(data)", call: () => reportAccess.assertCanExport("data") },
  // Backup & recovery (Phase 18). Each of these is refused before it reads a row,
  // which is the whole point of the ordering: a restore that checked its payload
  // before its permission would tell an unauthorised caller what the database
  // looks like on the way to refusing them.
  { name: "backupService.loadBackups", call: () => backupService.loadBackups() },
  { name: "backupService.loadStatus", call: () => backupService.loadStatus() },
  { name: "backupService.createBackup", call: () => backupService.createBackup("manual", "should not run") },
  { name: "backupService.saveBackupSettings", call: () => backupService.saveBackupSettings({ frequency: "daily" }) },
  { name: "backupService.downloadBackup", call: () => backupService.downloadBackup("bk-does-not-exist") },
  { name: "backupService.runHealthCheck", call: () => backupService.runHealthCheck() },
  { name: "backupService.restoreBackup", call: () => backupService.restoreBackup({
      id: "bk-does-not-exist",
      confirmation: "RESTORE",
    }) },
];

test("every write funnel refuses a caller with no capabilities", async () => {
  installStorageStub();
  signOut();
  for (const funnel of FUNNELS) {
    const code = await refusalCode(funnel.call);
    assert.equal(code, "FORBIDDEN", `${funnel.name} refuses an unauthorised caller`);
  }
});

test("every write funnel refuses a read-only viewer before it touches data", async () => {
  installStorageStub();
  signInAs("viewer");
  for (const funnel of FUNNELS) {
    const code = await refusalCode(funnel.call);
    // A viewer holds the read/export capabilities, so an export gate is the one
    // funnel here it may pass; everything that writes must refuse it.
    if (funnel.name.startsWith("reportAccess.assertCanExport") && hasCapability("viewer", "export_data")) {
      assert.equal(code, null, `${funnel.name}: viewer holds export_data`);
      continue;
    }
    assert.equal(code, "FORBIDDEN", `${funnel.name} refuses viewer`);
  }
});

// ── 6. the till-level splits ──────────────────────────────────────────────
test("a cashier records money but does not sign it off", () => {
  installStorageStub();
  signInAs("cashier");

  // Recording a return is till work; settling its refund is oversight.
  assert.equal(refusalCodeSync(() => returnService.assertCanCreateReturn()), null, "cashier may process a return");
  assert.equal(refusalCodeSync(() => returnService.assertCanRecordRefund()), null, "cashier may record its refund");
  assert.equal(
    refusalCodeSync(() => returnService.assertCanSettleRefund()),
    "FORBIDDEN",
    "cashier may not complete a pending refund",
  );
  assert.equal(
    refusalCodeSync(() => returnService.assertCanRejectRefund()),
    "FORBIDDEN",
    "cashier may not reject a pending refund either",
  );

  // A price change at the till is allowed; writing the stock ledger is not.
  assert.equal(refusalCodeSync(() => catalogService.assertCanChangePrice()), null);
  assert.equal(refusalCodeSync(() => inventoryService.assertCanAdjustStock()), "FORBIDDEN");
  // Bulk import is gated by `import_data`, which the Phase 10 matrix does grant
  // a cashier. The point of the assertion is that the *matrix* decides, not the
  // module: change the grant and this line follows it.
  assert.equal(
    refusalCodeSync(() => inventoryService.assertCanImportStock()),
    hasCapability("cashier", "import_data") ? null : "FORBIDDEN",
  );

  // An expense may be filed by the person who spent it, approved by someone else.
  assert.equal(refusalCodeSync(() => expenseService.assertCanCreateExpense()), null);
  assert.equal(refusalCodeSync(() => expenseService.assertCanApproveExpense()), "FORBIDDEN");
  assert.equal(refusalCodeSync(() => expenseService.assertCanEditExpense()), "FORBIDDEN");

  // A shift is theirs to open and close; the difference is a manager's to sign.
  assert.equal(refusalCodeSync(() => shiftService.assertCanOpenShift()), null);
  assert.equal(refusalCodeSync(() => shiftService.assertCanCloseShift()), null);
  assert.equal(refusalCodeSync(() => shiftService.assertCanApproveShiftAdjustment()), "FORBIDDEN");

  // And the audit trail — which would show all of the above — is oversight only.
  assert.equal(refusalCodeSync(() => auditService.assertCanViewAudit()), "FORBIDDEN");

  // A manager settles what a cashier may not.
  signInAs("manager");
  assert.equal(refusalCodeSync(() => returnService.assertCanSettleRefund()), null);
  assert.equal(refusalCodeSync(() => expenseService.assertCanApproveExpense()), null);
  assert.equal(refusalCodeSync(() => shiftService.assertCanApproveShiftAdjustment()), null);
});

test("a rejected refund without a reason is refused for the right reason", async () => {
  installStorageStub();
  signInAs("manager");
  const code = await refusalCode(() => returnService.settleRefund("ref-x", "rejected", "   "));
  assert.equal(code, "VALIDATION", "the approver is told a reason is required, not that they lack permission");
});

// ── 7. immutability is not a permission ───────────────────────────────────
test("sales are immutable for everyone; product deletion follows the lifecycle", async () => {
  installStorageStub();
  signInAs("admin");

  const edit = await refusalCode(() => saleService.editSale("sale-x", {} as never));
  assert.equal(edit, "VALIDATION", "editing a completed sale is refused on immutability, not permission");

  const del = await refusalCode(() => saleService.deleteSale("sale-x"));
  assert.equal(del, "VALIDATION", "deleting a sale is refused on immutability, not permission");

  // Product deletion is a lifecycle (Phase 25), not a dead end: an id that
  // matches nothing is a NOT_FOUND for every privilege level, exactly the way
  // a sold product being deactivated is a rule, not a privilege. The
  // referenced/unused/cascade cases themselves are the lifecycle suite's.
  const ghost = await refusalCode(() => catalogService.deleteProduct("p-x"));
  assert.equal(ghost, "NOT_FOUND", "deleting a product id that does not exist is NOT_FOUND, not a permission question");

  // …while the same calls from a viewer are a permission refusal first.
  signInAs("viewer");
  assert.equal(await refusalCode(() => saleService.editSale("sale-x", {} as never)), "FORBIDDEN");
  assert.equal(await refusalCode(() => catalogService.deleteProduct("p-x")), "FORBIDDEN");
});

test("the audit vocabulary and the register agree about who may read the trail", () => {
  installStorageStub();
  for (const role of APP_ROLES) {
    signInAs(role);
    const mayView = hasCapability(role, "view_audit_log");
    const mayExport = hasCapability(role, "export_data");
    assert.equal(refusalCodeSync(() => auditService.assertCanViewAudit()), mayView ? null : "FORBIDDEN", `${role}: view`);
    assert.equal(refusalCodeSync(() => auditService.assertCanExportAudit()), mayView && mayExport ? null : "FORBIDDEN", `${role}: export needs both`);
    assert.equal(reportAccess.mayExport("data"), mayExport, `${role}: data export follows export_data`);
    assert.equal(reportAccess.mayViewReports(), hasCapability(role, "view_reports"), `${role}: reports follow view_reports`);
  }
});

// ── 8. monitoring inherits the gates of what it reports on ────────────────
test("the reservation monitoring surfaces are gated by the capabilities they act on", () => {
  const root = repoRoot();
  const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

  // Reading holds is the online queue's capability; settling them is the stock
  // ledger's. The screen asks for both, in the places that matter.
  const holds = read("src/modules/online/pages/StockHoldsPage.tsx");
  assert.ok(holds.includes("if (!canManage)"), "the screen itself is gated on working the queue");
  assert.ok(
    holds.includes("mayRepairReservations()"),
    "and its repair buttons on the stock ledger's capability",
  );
  assert.ok(
    holds.includes("{mayRepair ?"),
    "somebody who may read but not repair sees the findings without the buttons",
  );

  // The dashboard widget reads the same review, so it must not widen who sees it.
  const widget = read("src/modules/online/components/ReservationSummaryCard.tsx");
  assert.ok(
    widget.includes("if (!canManage || holdReview.rows.length === 0) return null;"),
    "the widget renders nothing for somebody who cannot work the queue",
  );

  // The sidebar badge sits on the nav row the route table already gates, so a
  // count never appears for somebody who could not open the screen behind it.
  const shell = read("src/components/layout/AppShell.tsx");
  assert.ok(
    /to="\/online\/reservations"[\s\S]{0,300}?visible=\{canOpen\("\/online\/reservations"\)\}[\s\S]{0,300}?badge=\{online\.holdAlertCount\}/.test(
      shell,
    ),
    "the holds badge is on the gated nav row, not beside it",
  );

  // The alerts come from the queue provider, which loads nothing at all for a
  // session that may not work the queue — so there is nothing to report upward,
  // and no second channel carrying numbers past a permission.
  const provider = read("src/modules/online/hooks/OnlineOrdersProvider.tsx");
  assert.ok(
    provider.includes("if (!canManage) {"),
    "the provider that computes the alerts loads nothing without the capability",
  );
  assert.ok(
    provider.includes("reportHoldAlerts(alertsRef.current)"),
    "and publishes them through the existing notification state, not a channel of its own",
  );

  // Repair still refuses at the funnel, whatever the UI showed: the buttons are a
  // courtesy, the guard is the gate.
  const service = read("src/modules/online/services/reservationRepair.ts");
  for (const funnel of ["repairHold", "restoreHold"]) {
    const body = service.slice(service.indexOf(`export async function ${funnel}`));
    assert.ok(
      body.slice(0, 400).includes("assertCanRepairReservations()"),
      `${funnel}() asserts the capability before it touches a hold`,
    );
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
console.log(`\n${passed}/${tests.length} enforcement tests passed.`);
if (failed > 0) process.exit(1);
