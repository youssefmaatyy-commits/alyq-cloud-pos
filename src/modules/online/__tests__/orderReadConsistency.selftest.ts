import assert from "node:assert/strict";
import { OrderReadConsistency } from "../services/orderReadConsistency";

const reads = new OrderReadConsistency();
const oldFilter = reads.beginLoad();
const currentFilter = reads.beginLoad();
assert.equal(reads.canApplyLoad(oldFilter), false, "an older filter cannot replace the current queue");
assert.equal(reads.isLatestLoad(oldFilter), false, "an older finally block cannot clear current loading state");
assert.equal(reads.canApplyLoad(currentFilter), true);

const firstDrawer = reads.beginSelection();
const secondDrawer = reads.beginSelection();
assert.equal(reads.canApplySelection(firstDrawer), false, "late getOrder cannot switch the clerk back to a previous order");
assert.equal(reads.canApplySelection(secondDrawer), true);
assert.equal(reads.canApplyLoadSelection(currentFilter), false, "a load started before a selection cannot clear that drawer");

reads.beginSelection(); // Close is also a selection change.
assert.equal(reads.canApplySelection(secondDrawer), false, "a closed drawer is never reopened by its late response");

const beforeVerification = reads.beginSelection();
const listBeforeVerification = reads.beginLoad();
reads.recordMutation(); // Request payment verification immediately, without sleeping for getOrder.
assert.equal(reads.canApplySelection(beforeVerification), false, "an unverified snapshot cannot undo a new payment decision");
assert.equal(reads.canApplyLoad(listBeforeVerification), false, "the old queue snapshot cannot undo a payment decision either");
const duringVerification = reads.beginSelection();
const listDuringVerification = reads.beginLoad();
reads.recordMutation(); // Commit the paid result.
assert.equal(reads.canApplySelection(duringVerification), false, "a read made while payment was in flight cannot roll back Paid");
assert.equal(reads.canApplyLoad(listDuringVerification), false);

const afterVerification = reads.beginSelection();
const freshList = reads.beginLoad();
assert.equal(reads.canApplySelection(afterVerification), true, "fresh reads after commit remain supported");
assert.equal(reads.canApplyLoad(freshList), true);
assert.equal(reads.canApplyLoadSelection(freshList), true);

console.log("14/14 order snapshot, filter, drawer-close and payment-verification race tests passed");
