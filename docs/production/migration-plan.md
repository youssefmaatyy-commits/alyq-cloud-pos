# Production migration plan — 0001 through 0094

This is an operator plan, not evidence of hosted execution. The repository contains 94 contiguous forward migrations from `0001_create_categories.sql` through `0094_web_push_subscriptions.sql`. Historical files must not be edited.

## Determine the exact pending range

1. Freeze the approved Git SHA and independently confirm the Production project.
2. Export the provider migration ledger and schema before changing anything.
3. Compare every recorded migration name/checksum to this repository. **Stop on drift, gaps, renamed files, unknown later migrations, or a partially applied file.** Do not infer success from object existence alone.
4. If the target is empty, the exact ordered range is `0001`–`0094`.
5. If the target has a matching contiguous prefix ending at `NNNN`, the exact pending range is `NNNN+1`–`0094`.
6. If it already has a matching `0001`–`0094`, no database migration is pending. Never replay merely to create evidence.

## Mandatory execution sequence

- Complete the verified database, Storage and configuration backup plus isolated restore drill.
- Prove the pending range on staging restored from production-like data.
- Keep the prior compatible clients available and assign stop/rollback authority.
- Apply each pending file in numeric order with stop-on-error and transaction semantics. Record filename, checksum, start/end UTC, outcome and operator.
- Stop on the first error. Do not run later files and do not mark a failed file applied manually.
- After success, re-export the ledger and verify maximum `0094_web_push_subscriptions.sql`, expected schema/RPC parity, RLS/grants, branch isolation, audit append-only behavior and staging smoke tests.

## Release-safety audit (2026-10-11)

No new migration or production write is needed for the explicit-mode/UI/CI/promotion changes. Historical migrations are unchanged; the current repository manifest contains 94 files. The local required database gate applies and reapplies that complete manifest only in an isolated PGlite database, including RLS, exact stock/reservations, branch isolation, permissions, audit and financial scenarios. Record actual command results separately; this document is not proof of hosted execution.

## Historical dry-run evidence from preparation

On 2026-10-04, `npm run db:check` applied all 85 migrations to a fresh in-process PostgreSQL-compatible PGlite database, then reapplied all 85 to test idempotency. Role/RLS (including the 0085 first-admin bootstrap scenario), focused branch/approval/cleanup/inventory/register/mobile scenarios, Final Store QA, seed idempotency and application schema parity all passed.

A separate disposable PGlite probe deliberately created a table and row inside a transaction, raised a division-by-zero failure, rolled back, and confirmed `to_regclass(...)` was null. This verifies the local transaction/failure harness. It does **not** replace a real PostgreSQL/Supabase staging rehearsal or prove every provider operation is transactional.

## Failure recovery

Capture the error and transaction status without retrying. If the failed file rolled back fully, leave clients on the prior compatible version, correct the defect only through a new reviewed forward migration after staging rehearsal, and restart under a new approval. If state is ambiguous, partially committed or incompatible, invoke `backup-restore.md` and `rollback-runbook.md`; do not improvise reverse SQL.
