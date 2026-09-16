/**
 * Customers — Phase 27 tests: the optional email and the till's search rule.
 *
 * Email is the column the till's quick-add always wanted (0038): optional,
 * length-capped, blank-normalised to null. `filterCustomers` is the single
 * search rule the register's picker, and anything else, may use — name or
 * phone, either one, case-insensitive.
 */
import assert from "node:assert/strict";
import process from "node:process";

import {
  EMPTY_CUSTOMER_FORM,
  MAX_CUSTOMER_EMAIL,
  validateCustomerDraft,
} from "../validation";
import { filterCustomers } from "../services/customerQuery";
import { getDemoCustomerRepository } from "../data/demoRepository";
import type { Customer } from "../types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function cust(partial: Partial<Customer> & { id: string }): Customer {
  return {
    name: `Customer ${partial.id}`,
    phone: `050000000${partial.id}`,
    email: null,
    address: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

console.log("\nPhase 27 · customer email + till search");

test("email is optional: blank stays null, valid passes through", () => {
  const blank = validateCustomerDraft(
    { ...EMPTY_CUSTOMER_FORM, name: "X", phone: "0501111111" },
    [],
  );
  assert.ok(blank.data);
  assert.equal(blank.data.email, null);

  const withEmail = validateCustomerDraft(
    { ...EMPTY_CUSTOMER_FORM, name: "X", phone: "0501111111", email: " ahmed@example.com " },
    [],
  );
  assert.ok(withEmail.data);
  assert.equal(withEmail.data.email, "ahmed@example.com");
});

test("email is validated when present", () => {
  const bad = validateCustomerDraft(
    { ...EMPTY_CUSTOMER_FORM, name: "X", phone: "0501111111", email: "not-an-email" },
    [],
  );
  assert.equal(bad.errors.email, "emailInvalid");
  assert.equal(bad.data, null);

  const long = validateCustomerDraft(
    { ...EMPTY_CUSTOMER_FORM, name: "X", phone: "0501111111", email: `a${"b".repeat(MAX_CUSTOMER_EMAIL)}@x.com` },
    [],
  );
  assert.equal(long.errors.email, "emailInvalid");

  const spaced = validateCustomerDraft(
    { ...EMPTY_CUSTOMER_FORM, name: "X", phone: "0501111111", email: "a b@example.com" },
    [],
  );
  assert.equal(spaced.errors.email, "emailInvalid");
});

test("the book round-trips an email (demo repository)", async () => {
  const repo = getDemoCustomerRepository();
  const created = await repo.createCustomer({
    name: "Email Carrier",
    phone: "0599000777",
    email: "carrier@example.com",
    address: null,
    notes: null,
  });
  assert.equal(created.email, "carrier@example.com");

  const cleared = await repo.updateCustomer(created.id, { email: "   " });
  assert.equal(cleared.email, null);
});

test("filterCustomers: name or phone, case-insensitive, both together", () => {
  const book = [
    cust({ id: "1", name: "Ahmed Al-Sharif", phone: "0501234567" }),
    cust({ id: "2", name: "Sarah Al-Mahmoud", phone: "0559876543" }),
    cust({ id: "3", name: "Andalus Cafe", phone: "0541122334" }),
  ];

  assert.deepEqual(
    filterCustomers(book, "ahmed").map((c) => c.id),
    ["1"],
  );
  // phone search, digits only, with a space the user typed
  assert.deepEqual(
    filterCustomers(book, "055 9876").map((c) => c.id),
    ["2"],
  );
  // empty query = the whole book
  assert.equal(filterCustomers(book, "").length, 3);
  assert.equal(filterCustomers(book, "   ").length, 3);
  // no match
  assert.deepEqual(filterCustomers(book, "nobody"), []);
  // the limit bounds the suggestion list
  assert.equal(filterCustomers(book, "", 2).length, 2);
});

let passed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    console.error(`  ✗ ${t.name}`);
    console.error(err);
    process.exit(1);
  }
}
console.log(`\n${passed}/${tests.length} Phase 27 customer tests passed`);
