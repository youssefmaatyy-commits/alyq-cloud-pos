# POS offline-first boundaries

The offline path is deliberately a **cash-capture contingency**, not a second financial system.

## What works offline

- The register opens from the last successfully loaded IndexedDB catalog snapshot: products, exact variants, SKU/barcode values, activity flags and last-known quantities.
- A cashier may complete **one cash payment** sale only. It receives a local `OFFLINE-…` receipt/reference and is written atomically with its exact variant lines and an immutable `client_ref` outbox record.
- The displayed local sale is explicitly Pending Sync. The server replays the same payload/idempotency key when online and is the final authority for catalog state, shift, permissions, stock, promotion and money.
- Held carts are local drafts. They preserve their selected customer snapshot, exact variants, display prices, manual discounts, coupon text and notes, but reserve/decrement nothing.

## Intentionally unavailable offline

- Coupon application, promotion validation and coupon consumption (they require live authoritative pricing).
- Card, InstaPay, split payment, payment confirmation, returns/refunds, voids, approval workflows, stock adjustments, customer creation/editing and shift open/close.
- New customer lookup after a reload and a claim that a shift remains open: the live server verifies both on synchronization. A customer already selected in the active register session is carried in the queued sale snapshot.
- A held cart's prior coupon is restored as text only and must be explicitly re-applied online before payment.

## Synchronization and conflicts

The register automatically attempts pending/network-failed items on reconnect. It only replays the persisted input and never sends cached browser prices as authority. A successful response marks the local audit record **Synced** and removes its outbox pointer.

Stock and business-rule refusals remain durable **Conflict**/**Failed** records with their response text. They are not auto-retried and the cashier retry action only retries network failures; staff must review the preserved transaction and make a new, authorized business decision. No queue processing silently edits, drops or re-books a financial fact.
